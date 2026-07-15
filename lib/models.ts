// lib/models.ts
// NVIDIA Integrate API model IDs — verified via /api/models on this key.

export const MODELS = {
  // General-purpose flagships
  llama70:       'meta/llama-3.3-70b-instruct',
  llama4Mav:     'meta/llama-4-maverick-17b-128e-instruct',
  nemotron70:    'nvidia/llama-3.1-nemotron-70b-instruct',
  nemotronSuper: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  nemotronUltra: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  nemotronNano9: 'nvidia/nvidia-nemotron-nano-9b-v2',
  nemotron3Sup:  'nvidia/nemotron-3-super-120b-a12b',

  // Qwen (large MoE reasoning models)
  qwen3Next:     'qwen/qwen3-next-80b-a3b-instruct',
  qwen35Big:     'qwen/qwen3.5-122b-a10b',
  qwen35Huge:    'qwen/qwen3.5-397b-a17b',

  // DeepSeek
  deepseekPro:   'deepseek-ai/deepseek-v4-pro',
  deepseekFlash: 'deepseek-ai/deepseek-v4-flash',

  // Mistral
  mistralLg3:    'mistralai/mistral-large-3-675b-instruct-2512',
  mistralSm4:    'mistralai/mistral-small-4-119b-2603',
  mixtral:       'mistralai/mixtral-8x22b-v0.1',

  // OpenAI open-weight
  gptOss120:     'openai/gpt-oss-120b',
  gptOss20:      'openai/gpt-oss-20b',

  // Google Gemma
  gemma4:        'google/gemma-4-31b-it',

  // Moonshot / MiniMax / others
  kimi:          'moonshotai/kimi-k2.6',
  minimax3:      'minimaxai/minimax-m3',
  glm52:         'z-ai/glm-5.2',

  // Small/fast
  llama8:        'meta/llama-3.1-8b-instruct',
  nemotronNano8: 'nvidia/llama-3.1-nemotron-nano-8b-v1',
} as const;

export type ModelKey = keyof typeof MODELS;
export type ModelId  = typeof MODELS[ModelKey];

/** Resolve a caller-supplied string to a model id — accepts alias or full id. */
export function resolveModel(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  if (input in MODELS) return MODELS[input as ModelKey];
  return input; // treat as raw model id
}
