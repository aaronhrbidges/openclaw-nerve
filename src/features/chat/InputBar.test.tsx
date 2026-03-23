import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  clearVoiceError,
  toggleWakeWord,
  onSend,
  compressImage,
  useVoiceInputMock,
} = vi.hoisted(() => ({
  clearVoiceError: vi.fn(),
  toggleWakeWord: vi.fn(),
  onSend: vi.fn(),
  compressImage: vi.fn(async (file: File) => ({
    base64: 'ZmFrZS1pbWFnZQ==',
    mimeType: file.type || 'image/png',
    preview: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
  })),
  useVoiceInputMock: vi.fn(() => ({
    voiceState: 'idle',
    interimTranscript: '',
    wakeWordEnabled: false,
    toggleWakeWord: vi.fn(),
    error: null,
    clearError: vi.fn(),
  })),
}));

vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: () => ({
    sessions: [{ key: 'agent:test:main', label: 'Test agent' }],
    currentSession: 'agent:test:main',
    agentName: 'Nerve',
  }),
}));

vi.mock('@/contexts/SettingsContext', () => ({
  useSettings: () => ({
    liveTranscriptionPreview: false,
    sttInputMode: 'push-to-talk',
    sttProvider: 'local',
  }),
}));

vi.mock('@/features/voice/useVoiceInput', () => ({
  useVoiceInput: (...args: Parameters<typeof useVoiceInputMock>) => useVoiceInputMock(...args),
}));

vi.mock('./image-compress', () => ({
  compressImage: (...args: Parameters<typeof compressImage>) => compressImage(...args),
}));

import { InputBar } from './InputBar';

function renderInputBar(isGenerating = true) {
  return render(<InputBar onSend={onSend} isGenerating={isGenerating} />);
}

describe('InputBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    useVoiceInputMock.mockReturnValue({
      voiceState: 'idle',
      interimTranscript: '',
      wakeWordEnabled: false,
      toggleWakeWord,
      error: null,
      clearError: clearVoiceError,
    });

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ language: 'en' }),
    } as Response)) as typeof fetch;
  });

  it('does not send on Enter while generating', async () => {
    const user = userEvent.setup();
    renderInputBar(true);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'Draft message');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Draft message');
  });

  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Cmd+Enter', { metaKey: true }],
  ])('does not send on %s while generating', async (_label, modifier) => {
    const user = userEvent.setup();
    renderInputBar(true);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'Shortcut draft');

    fireEvent.keyDown(textarea, { key: 'Enter', ...modifier });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Shortcut draft');
  });

  it('keeps pending attachments after a blocked keyboard send', async () => {
    const user = userEvent.setup();
    const { container } = renderInputBar(true);

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();

    const image = new File(['fake-image'], 'proof.png', { type: 'image/png' });
    await user.upload(fileInput as HTMLInputElement, image);

    expect(await screen.findByText('proof.png')).toBeInTheDocument();

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'Draft with attachment');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Draft with attachment');
    expect(screen.getByText('proof.png')).toBeInTheDocument();
    expect(compressImage).toHaveBeenCalledWith(image);
  });

  it('shows an abort note while generating and removes it when generation stops', () => {
    const { rerender } = renderInputBar(true);

    expect(screen.getByText('Abort current response first')).toBeInTheDocument();

    rerender(<InputBar onSend={onSend} isGenerating={false} />);

    expect(screen.queryByText('Abort current response first')).not.toBeInTheDocument();
  });
});
