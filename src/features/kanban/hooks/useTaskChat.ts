/**
 * useTaskChat — Connects the task detail drawer chat to an OpenClaw phase session.
 *
 * Loads history via RPC, subscribes to gateway events for streaming,
 * and sends messages through the gateway chat RPC.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useGateway } from '@/contexts/GatewayContext';
import type { ChatStreamState } from '@/contexts/ChatContext';
import type { ChatMsg } from '@/features/chat/types';
import type { GatewayEvent } from '@/types';
import type { KanbanTask, SddPhase } from '../types';
import {
  loadChatHistory,
  classifyStreamEvent,
  extractStreamDelta,
  extractFinalMessages,
  processChatMessages,
} from '@/features/chat/operations';
import { buildUserMessage, sendChatMessage } from '@/features/chat/operations/sendMessage';

interface UseTaskChatOptions {
  task: KanbanTask | null;
  phase?: SddPhase;
}

interface UseTaskChatReturn {
  messages: ChatMsg[];
  isGenerating: boolean;
  stream: ChatStreamState;
  sessionKey: string | null;
  phase: SddPhase | null;
  isReadOnly: boolean;
  send: (text: string) => Promise<void>;
}

export function useTaskChat({ task, phase }: UseTaskChatOptions): UseTaskChatReturn {
  const { rpc, subscribe, connectionState } = useGateway();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [stream, setStream] = useState<ChatStreamState>({ html: '' });
  const streamHtmlRef = useRef('');

  // Derive session key and read-only state from task's phase sessions
  const { sessionKey, activePhase, isReadOnly } = useMemo(() => {
    if (!task?.phaseSessions?.length) {
      return { sessionKey: null, activePhase: null, isReadOnly: true };
    }

    const targetPhase = phase ?? task.currentPhase;
    if (!targetPhase) {
      return { sessionKey: null, activePhase: null, isReadOnly: true };
    }

    // Find the session matching the requested phase (last one if multiple retries)
    const matching = task.phaseSessions.filter(s => s.phase === targetPhase);
    const session = matching.length > 0 ? matching[matching.length - 1] : null;

    if (!session) {
      return { sessionKey: null, activePhase: targetPhase, isReadOnly: true };
    }

    return {
      sessionKey: session.sessionKey,
      activePhase: targetPhase,
      isReadOnly: session.status === 'completed' || session.status === 'error',
    };
  }, [task?.phaseSessions, task?.currentPhase, phase]);

  // Load history when session key changes
  useEffect(() => {
    if (!sessionKey || connectionState !== 'connected') {
      setMessages([]);
      setIsGenerating(false);
      setStream({ html: '' });
      streamHtmlRef.current = '';
      return;
    }

    let cancelled = false;

    loadChatHistory({ rpc, sessionKey })
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((err) => {
        console.error('[useTaskChat] Failed to load history:', err);
        if (!cancelled) setMessages([]);
      });

    return () => { cancelled = true; };
  }, [sessionKey, rpc, connectionState]);

  // Subscribe to gateway events filtered by session key
  useEffect(() => {
    if (!sessionKey || connectionState !== 'connected') return;

    const unsub = subscribe((event: GatewayEvent) => {
      const classified = classifyStreamEvent(event);
      if (!classified || classified.sessionKey !== sessionKey) return;

      switch (classified.type) {
        case 'chat_started':
          setIsGenerating(true);
          streamHtmlRef.current = '';
          setStream({ html: '' });
          break;

        case 'chat_delta': {
          if (classified.chatPayload) {
            const delta = extractStreamDelta(classified.chatPayload);
            if (delta.cleaned) {
              streamHtmlRef.current += delta.cleaned;
              setStream({ html: streamHtmlRef.current, runId: classified.runId });
            }
          }
          break;
        }

        case 'chat_final': {
          setIsGenerating(false);
          streamHtmlRef.current = '';
          setStream({ html: '' });

          // Merge final messages into the list
          if (classified.chatPayload) {
            const finalMsgs = extractFinalMessages(classified.chatPayload);
            if (finalMsgs.length > 0) {
              const processed = processChatMessages(finalMsgs);
              setMessages(prev => [...prev, ...processed]);
            }
          }
          break;
        }

        case 'chat_error':
        case 'chat_aborted':
          setIsGenerating(false);
          streamHtmlRef.current = '';
          setStream({ html: '' });
          break;
      }
    });

    return unsub;
  }, [sessionKey, subscribe, connectionState]);

  // Send a message to the phase session
  const send = useCallback(async (text: string) => {
    if (!sessionKey || isReadOnly || !text.trim()) return;

    // Optimistic user bubble
    const { msg: userMsg, tempId } = buildUserMessage({ text });
    setMessages(prev => [...prev, userMsg]);

    try {
      await sendChatMessage({
        rpc,
        sessionKey,
        text,
        idempotencyKey: tempId,
      });
    } catch (err) {
      console.error('[useTaskChat] Send failed:', err);
      // Mark the optimistic message as failed
      setMessages(prev =>
        prev.map(m => m.tempId === tempId ? { ...m, pending: false, error: true } : m)
      );
    }
  }, [sessionKey, isReadOnly, rpc]);

  return {
    messages,
    isGenerating,
    stream,
    sessionKey,
    phase: activePhase,
    isReadOnly,
    send,
  };
}
