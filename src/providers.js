/**
 * Direct free-provider registry.
 *
 * When Free Claude Code is not running, the router can still reach the same
 * upstream providers with the keys fcc already stores in `~/.fcc/.env`. Each
 * entry below is an OpenAI-compatible endpoint; the bootstrap model list is
 * used only when the endpoint's own `/models` call fails.
 *
 * @module dsh-freeclaudecode-auto/providers
 */

import { tierOf, trimSlash } from './util.js'

/**
 * Built-in OpenAI-compatible providers.
 * @type {ReadonlyArray<{id: string, label: string, baseUrl: string, env: string[], models: string[]}>}
 */
export const DIRECT_PROVIDERS = Object.freeze([
  {
    id: 'nvidia_nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    env: ['NVIDIA_NIM_API_KEY'],
    models: [
      'meta/llama-3.3-70b-instruct',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'deepseek-ai/deepseek-v3.1',
      'moonshotai/kimi-k2-instruct',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    ],
  },
  {
    id: 'open_router',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    models: ['deepseek/deepseek-chat-v3.1:free', 'qwen/qwen3-coder:free', 'z-ai/glm-4.6:free', 'moonshotai/kimi-k2:free'],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEY'],
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct'],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    env: ['CEREBRAS_API_KEY'],
    models: ['gpt-oss-120b', 'qwen-3-coder-480b'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEY'],
    models: ['devstral-small-latest', 'codestral-latest', 'mistral-large-latest'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEY'],
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'gemini',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    env: ['TOGETHER_API_KEY'],
    models: ['zai-org/GLM-4.6', 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'deepseek-ai/DeepSeek-V3.1'],
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    env: ['SAMBANOVA_API_KEY'],
    models: ['Meta-Llama-3.3-70B-Instruct', 'DeepSeek-V3-0324'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    env: ['SILICONFLOW_API_KEY'],
    models: ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'deepseek-ai/DeepSeek-V3.1'],
  },
  {
    id: 'nebius',
    label: 'Nebius',
    baseUrl: 'https://api.studio.nebius.com/v1',
    env: ['NEBIUS_API_KEY'],
    models: ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'deepseek-ai/DeepSeek-V3.1'],
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    env: ['FIREWORKS_API_KEY'],
    models: ['accounts/fireworks/models/deepseek-v3p1', 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct'],
  },
  {
    id: 'novita',
    label: 'Novita',
    baseUrl: 'https://api.novita.ai/v3/openai',
    env: ['NOVITA_API_KEY'],
    models: ['deepseek/deepseek-v3.1', 'qwen/qwen3-coder-480b-a35b-instruct'],
  },
  {
    id: 'zai',
    label: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    env: ['ZAI_API_KEY'],
    models: ['glm-4.6', 'glm-4.5-air'],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    env: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    env: ['MINIMAX_API_KEY'],
    models: ['MiniMax-M2'],
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    env: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
    models: ['Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest', 'deepseek-ai/DeepSeek-V3.1:fastest'],
  },
])

/**
 * Model families that are not chat models. Free catalogs list embedding,
 * reranking, guardrail, PII, translation, and speech models beside chat
 * models; routing a conversation to one of them wastes a failover at best and
 * returns a nonsensical 422 at worst.
 */
const NON_CHAT_MODEL = /embed|clip|detector|starcoder|rerank|guard|safety|moderation|classif(?:ier|ication)|pii|calibrat|translate|transcri|whisper|tts|ocr|asr|speech|nemoguard/iu

/**
 * Whether an advertised model can answer a chat request.
 * @param {string} id - provider model id.
 * @returns {boolean} true for a conversational model.
 */
export function isChatModel(id) {
  return typeof id === 'string' && id !== '' && !NON_CHAT_MODEL.test(id)
}

/**
 * Resolve one provider's credential from the merged environment.
 * @param {{env: string[]}} provider - provider definition.
 * @param {Record<string, string | undefined>} env - merged environment.
 * @returns {string} the key, or '' when no variable is set.
 */
export function providerKey(provider, env) {
  for (const name of provider.env) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * Ask an OpenAI-compatible endpoint which models it serves.
 * @param {string} baseUrl - endpoint root.
 * @param {string} apiKey - credential.
 * @param {object} options - discovery options.
 * @param {Function} options.fetchImpl - fetch implementation.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {number} [options.timeoutMs] - per-provider deadline.
 * @returns {Promise<string[]>} model ids, empty when discovery is unavailable.
 */
export async function discoverProviderModels(baseUrl, apiKey, { fetchImpl, signal, timeoutMs = 4000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${trimSlash(baseUrl)}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
    })
    if (!response.ok) return []
    const payload = await response.json()
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
    const ids = []
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : typeof entry?.id === 'string' ? entry.id : ''
      if (id !== '' && !ids.includes(id)) ids.push(id)
      if (ids.length >= 200) break
    }
    return ids
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the direct-provider candidates.
 *
 * @param {object} options - build options.
 * @param {object} options.config - resolved plugin config.
 * @param {Record<string, string | undefined>} options.env - merged environment.
 * @param {Function} options.fetchImpl - fetch implementation.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {boolean} [options.discover] - whether to call each endpoint's `/models`.
 * @returns {Promise<object[]>} candidate records.
 */
export async function buildDirectCandidates({ config, env, fetchImpl, signal, discover = true }) {
  if (!config.directProviders.enabled) return []
  const candidates = []
  const definitions = [
    ...DIRECT_PROVIDERS,
    ...config.extraProviders.map(entry => ({
      id: entry.id,
      label: entry.label,
      baseUrl: entry.baseUrl,
      env: entry.apiKeyEnv === '' ? [] : [entry.apiKeyEnv],
      models: entry.models,
      ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
      ...entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens },
      wire: entry.wire,
      tier: entry.tier,
      tools: entry.tools,
      headers: entry.headers,
      extras: true,
    })),
  ]

  const perProvider = await Promise.all(definitions.map(async (provider) => {
    const apiKey = providerKey(provider, env)
    if (apiKey === '' && provider.extras !== true) return []
    const discovered = provider.extras !== true && discover && apiKey !== ''
      ? await discoverProviderModels(provider.baseUrl, apiKey, { fetchImpl, signal })
      : []
    const models = discovered.length > 0 ? discovered : provider.models ?? []
    const records = []
    for (const model of models) {
      if (typeof model !== 'string' || model === '') continue
      records.push({
        catalogId: `${provider.id}/${model}`,
        key: `direct:${provider.id}:${model}`,
        source: 'direct',
        provider: provider.id,
        upstreamModel: model,
        label: `${provider.label}: ${model}`,
        wire: provider.wire ?? 'openai',
        baseUrl: trimSlash(provider.baseUrl),
        apiKey,
        tier: provider.tier ?? tierOf(model),
        tools: provider.tools !== false,
        contextWindow: provider.contextWindow ?? 0,
        maxTokens: provider.maxTokens ?? 0,
        headers: provider.headers ?? {},
      })
    }
    return records
  }))
  return perProvider.flat()
}

/**
 * Fill in tier, context, and label defaults and remove duplicates.
 *
 * A direct candidate is dropped when an fcc model with the same provider slug
 * exists, because the identical model reached through fcc's proxy is the
 * preferred route.
 *
 * @param {object[]} fccCandidates - candidates from the fcc proxy.
 * @param {object[]} directCandidates - candidates reached directly.
 * @param {object} config - resolved plugin config.
 * @returns {object[]} the merged catalog.
 */
export function mergeCatalog(fccCandidates, directCandidates, config) {
  const fccSlugs = new Set(fccCandidates.map(candidate => candidate.upstreamModel))
  // A provider fcc already proxies is reached through fcc's curated catalog.
  // Adding that provider's raw /models output would reintroduce the embedding,
  // guardrail, and detector entries fcc deliberately leaves out of a chat list.
  const fccProviders = new Set(fccCandidates.map(candidate => candidate.provider))
  const seen = new Set()
  const merged = []
  for (const candidate of [...fccCandidates, ...directCandidates]) {
    if (!isChatModel(candidate.upstreamModel)) continue
    if (candidate.source === 'direct' && fccProviders.has(candidate.provider)) continue
    if (candidate.source === 'direct' && fccSlugs.has(`${candidate.provider}/${candidate.upstreamModel}`)) continue
    if (seen.has(candidate.catalogId)) continue
    seen.add(candidate.catalogId)
    const contextWindow = candidate.contextWindow > 0 ? candidate.contextWindow : 32768
    const maxTokens = candidate.maxTokens > 0 ? candidate.maxTokens : Math.min(8192, contextWindow)
    merged.push({
      ...candidate,
      tier: candidate.tier ?? tierOf(candidate.upstreamModel, candidate.label),
      contextWindow,
      maxTokens,
      tools: candidate.tools !== false,
      headers: candidate.headers ?? {},
    })
  }
  return merged
}

/**
 * Show a readable source label for one candidate.
 * @param {object} candidate - candidate record.
 * @returns {string} a short label.
 */
export function sourceLabel(candidate) {
  if (candidate.source === 'fcc') return `fcc:${candidate.upstreamModel}`
  return `${candidate.provider}/${candidate.upstreamModel}`
}
