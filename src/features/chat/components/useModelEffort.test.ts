import { describe, expect, it } from 'vitest';
import { buildModelCatalogUiError, buildSelectableModelList, type GatewayModelInfo } from './useModelEffort';

const CONFIGURED_MODELS: GatewayModelInfo[] = [
  { id: 'zai/glm-4.7', label: 'glm-4.7', provider: 'zai' },
  { id: 'ollama/qwen2.5:7b-instruct-q5_K_M', label: 'qwen-local', provider: 'ollama' },
];

describe('buildSelectableModelList', () => {
  it('returns configured models unchanged when available', () => {
    expect(buildSelectableModelList(CONFIGURED_MODELS, null)).toEqual(CONFIGURED_MODELS);
  });

  it('returns no fake fallback models when configured catalog is empty', () => {
    expect(buildSelectableModelList([], null)).toEqual([]);
  });

  it('appends the current active model when it is missing from the configured catalog', () => {
    expect(buildSelectableModelList(CONFIGURED_MODELS, 'openrouter/xiaomi/mimo-v2-pro')).toEqual([
      ...CONFIGURED_MODELS,
      { id: 'openrouter/xiaomi/mimo-v2-pro', label: 'xiaomi/mimo-v2-pro', provider: 'openrouter' },
    ]);
  });

  it('does not append a phantom model when a configured option already has the same base name', () => {
    const models: GatewayModelInfo[] = [
      { id: 'openai/gpt-5.4', label: 'gpt-5.4', provider: 'openai' },
    ];

    expect(buildSelectableModelList(models, 'openai-codex/gpt-5.4')).toEqual(models);
  });
});

describe('buildModelCatalogUiError', () => {
  it('returns the backend error when the configured catalog is empty', () => {
    expect(buildModelCatalogUiError([], 'Could not load configured models')).toBe('Could not load configured models');
  });

  it('suppresses the backend error when configured models exist', () => {
    expect(buildModelCatalogUiError(CONFIGURED_MODELS, 'Could not load configured models')).toBeNull();
  });
});
