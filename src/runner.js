/**
 * The zero-drop turn runner.
 *
 * One harness turn walks an ordered candidate plan. Each attempt streams under
 * two watchdogs (time to first byte and mid-stream stall) and buffers its tool
 * calls until they are complete. When an attempt fails recoverably the runner
 * either switches models before anything visible was emitted, or continues the
 * already-visible text on the next model, so the harness never sees a recoverable
 * provider error.
 *
 * @module dsh-freeclaudecode-auto/runner
 */

import { CODES, ProviderFailure, failureOf, isDegenerateResponse } from './failure.js'
import { profileOf, profileLabel } from './config.js'
import { mergeSignals, openStream } from './wire/http.js'
import { buildRequest as buildOpenAiRequest, parseResponse as parseOpenAi } from './wire/openai.js'
import { buildRequest as buildAnthropicRequest, parseResponse as parseAnthropic } from './wire/anthropic.js'

/** Characters buffered before a fresh response is released to the UI. */
export const DEGENERATE_WINDOW = 160

/** Wire implementations keyed by candidate protocol. */
const WIRES = {
  openai: { buildRequest: buildOpenAiRequest, parseResponse: parseOpenAi },
  anthropic: { buildRequest: buildAnthropicRequest, parseResponse: parseAnthropic },
}

/** Map one wire finish reason onto the harness vocabulary. */
function finishKind(finish, sawToolCalls) {
  if (sawToolCalls) return { kind: 'tool-calls' }
  const value = String(finish ?? '').toLowerCase()
  if (value === 'length' || value === 'max_tokens' || value === 'max_output_tokens') return { kind: 'max-tokens' }
  if (value === 'tool_calls' || value === 'tool_use' || value === 'function_call') return { kind: 'tool-calls' }
  if (value === 'content_filter' || value === 'refusal') {
    return { kind: 'error', failure: { message: 'the provider filtered this response', code: CODES.CONTENT_FILTERED } }
  }
  return { kind: 'stop' }
}

/** One terminal failure chunk. */
function failureFinish(failure) {
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/** One cancellation chunk. */
function abortedFinish() {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was cancelled', code: CODES.ABORTED } } }
}

/** Allocate the next block index for one turn. */
function allocate(state) {
  const index = state.nextIndex
  state.nextIndex += 1
  return index
}

/**
 * Build the runner.
 *
 * @param {object} options - runner dependencies.
 * @param {object} options.config - resolved plugin config.
 * @param {import('./pool.js').CandidatePool} options.pool - the candidate pool.
 * @param {{info: Function, warn: Function, debug: Function}} options.logger - diagnostics sink.
 * @param {object} options.status - status registry.
 * @param {Function} [options.fetchImpl] - fetch implementation, injectable for tests.
 * @returns {{stream: (options: object) => AsyncGenerator<object>}} the runner.
 */
export function createRunner({ config, pool, logger, status, fetchImpl = globalThis.fetch, onFailover }) {
  /**
   * Stream one complete harness turn.
   * @param {object} options - harness generate options.
   * @returns {AsyncGenerator<object>} harness chunks, ending in exactly one finish.
   */
  async function* stream(options) {
    const startedAt = Date.now()
    const requested = profileOf(options.model, config)
    const label = profileLabel(requested.profile, config)
    const plan = pool.plan({ profile: requested.profile, explicitId: requested.explicitId, options })

    if (plan.length === 0) {
      const snapshot = pool.snapshot()
      yield failureFinish({
        message: snapshot.size === 0
          ? `${label}: no free model is configured. Start Free Claude Code, or set a provider key in ~/.fcc/.env.`
          : `${label}: every free model is cooling down or retired`,
        code: CODES.NO_MODEL_AVAILABLE,
      })
      status.recordTurn({
        at: startedAt,
        label,
        requestedModel: options.model,
        servedModel: null,
        failovers: 0,
        durationMs: Date.now() - startedAt,
        error: 'no model available',
        attempts: [],
      })
      return
    }

    const state = {
      nextIndex: 0,
      text: '',
      textIndex: -1,
      textOpen: false,
      pending: '',
      pendingOpen: false,
      reasoning: '',
      reasoningIndex: -1,
      reasoningOpen: false,
      toolCalls: [],
      usage: undefined,
      emittedVisible: false,
    }

    let continuationText = ''
    let failovers = 0
    const attempts = []
    let lastFailure

    for (let index = 0; index < plan.length; index += 1) {
      if (options.signal?.aborted === true) {
        yield* closeBlocks(state, false)
        yield abortedFinish()
        status.recordTurn({
          at: startedAt,
          label,
          requestedModel: options.model,
          servedModel: attempts.at(-1)?.catalogId ?? null,
          failovers,
          durationMs: Date.now() - startedAt,
          error: 'cancelled',
          attempts,
        })
        return
      }

      const candidate = plan[index]
      const attemptStart = Date.now()
      let outcome
      try {
        outcome = yield* attempt({ candidate, options, state, continuationText, config, fetchImpl })
      } catch (error) {
        const failure = error instanceof ProviderFailure
          ? error.failure
          : failureOf(error, options.signal)
        lastFailure = failure
        const reaction = failure.code === CODES.ABORTED
          ? { reaction: 'aborted', cooldownMs: 0 }
          : pool.recordFailure(candidate, failure)
        attempts.push({
          catalogId: candidate.catalogId,
          outcome: 'failed',
          reaction: reaction.reaction,
          code: failure.code,
          status: failure.status ?? null,
          durationMs: Date.now() - attemptStart,
        })
        status.recordFailure({ catalogId: candidate.catalogId, failure, reaction: reaction.reaction })

        if (options.signal?.aborted === true || failure.code === CODES.ABORTED) {
          yield* closeBlocks(state, false)
          yield abortedFinish()
          status.recordTurn({
            at: startedAt,
            label,
            requestedModel: options.model,
            servedModel: null,
            failovers,
            durationMs: Date.now() - startedAt,
            error: 'cancelled',
            attempts,
          })
          return
        }

        if (reaction.reaction === 'context') {
          // The request itself is too large for this route; the harness owns
          // compaction, so failing over to a smaller model would only repeat it.
          yield* closeBlocks(state, false)
          yield failureFinish(failure)
          status.recordTurn({
            at: startedAt,
            label,
            requestedModel: options.model,
            servedModel: null,
            failovers,
            durationMs: Date.now() - startedAt,
            error: `context: ${failure.message}`,
            attempts,
          })
          return
        }

        const nextCandidate = plan[index + 1]
        if (state.emittedVisible && state.textOpen && config.continuation) {
          // Visible text stays open: the next model continues the same block.
          continuationText = state.text
          state.toolCalls = []
          state.usage = undefined
          yield* closeReasoning(state)
          logger.warn(
            `freeclaudecode: ${candidate.catalogId} failed after ${String(state.text.length)} visible chars (${failure.code}); `
            + `${nextCandidate === undefined ? 'no model left to continue' : `continuing on ${nextCandidate.catalogId}`}`,
          )
        } else {
          // Nothing visible yet: discard the partial attempt and start clean.
          state.text = ''
          state.pending = ''
          state.toolCalls = []
          state.usage = undefined
          continuationText = ''
          yield* closeBlocks(state, false)
          if (nextCandidate !== undefined) {
            logger.warn(
              `freeclaudecode: ${candidate.catalogId} failed (${failure.code}${failure.status === undefined ? '' : ` HTTP ${String(failure.status)}`}); `
              + `switching to ${nextCandidate.catalogId}`,
            )
          }
        }

        if (nextCandidate === undefined) {
          yield* closeBlocks(state, false)
          yield failureFinish({
            message: `${label} exhausted every free model. Last failure (${candidate.catalogId}): ${failure.message}`,
            code: failure.code,
          })
          status.recordTurn({
            at: startedAt,
            label,
            requestedModel: options.model,
            servedModel: null,
            failovers,
            durationMs: Date.now() - startedAt,
            error: `exhausted: ${failure.message}`,
            attempts,
          })
          return
        }

        failovers += 1
        status.recordFailover({
          at: Date.now(),
          from: candidate.catalogId,
          to: nextCandidate.catalogId,
          reaction: reaction.reaction,
          code: failure.code,
          switchMs: Date.now() - attemptStart,
        })
        onFailover?.(nextCandidate, failure)
        continue
      }

      // Success: emit the buffered remainder, complete tool calls, usage, finish.
      pool.recordSuccess(candidate, { ttftMs: outcome.ttftMs })
      yield* finishAttempt(state)
      attempts.push({
        catalogId: candidate.catalogId,
        outcome: 'served',
        ttftMs: outcome.ttftMs,
        durationMs: Date.now() - attemptStart,
      })

      const finish = finishKind(outcome.finish, state.toolCalls.length > 0 || outcome.sawToolCalls)
      if (finish.kind === 'error') {
        status.recordTurn({
          at: startedAt,
          label,
          requestedModel: options.model,
          servedModel: candidate.catalogId,
          failovers,
          durationMs: Date.now() - startedAt,
          ttftMs: outcome.ttftMs,
          error: finish.failure.message,
          attempts,
        })
        yield { type: 'finish', reason: finish }
        return
      }

      yield { type: 'finish', reason: finish }
      if (config.logTurns) {
        logger.info(
          `freeclaudecode: ${label} served by ${candidate.catalogId} in ${String(Date.now() - startedAt)}ms `
          + `(ttft ${String(outcome.ttftMs)}ms, failovers ${String(failovers)}, pool ${String(pool.list().length)})`,
        )
      }
      status.recordTurn({
        at: startedAt,
        label,
        requestedModel: options.model,
        servedModel: candidate.catalogId,
        failovers,
        durationMs: Date.now() - startedAt,
        ttftMs: outcome.ttftMs,
        error: null,
        attempts,
      })
      return
    }

    yield* closeBlocks(state, false)
    yield failureFinish({
      message: lastFailure === undefined
        ? `${label}: no free model produced a response`
        : `${label} exhausted every free model. Last failure: ${lastFailure.message}`,
      code: lastFailure?.code ?? CODES.NO_MODEL_AVAILABLE,
    })
  }

  /**
   * Run one candidate attempt and translate its wire events.
   *
   * @param {object} context - attempt context.
   * @param {object} context.candidate - the candidate to call.
   * @param {object} context.options - harness generate options.
   * @param {object} context.state - shared turn state.
   * @param {string} context.continuationText - text to continue, when resuming.
   * @param {object} context.config - resolved plugin config.
   * @param {Function} context.fetchImpl - fetch implementation.
   * @returns {AsyncGenerator<object, {finish: string, ttftMs: number, sawToolCalls: boolean}>} chunks, returning the outcome.
   */
  async function* attempt({ candidate, options, state, continuationText, config, fetchImpl }) {
    const wire = WIRES[candidate.wire] ?? WIRES.openai
    const controller = new AbortController()
    const signal = options.signal === undefined ? controller.signal : mergeSignals([options.signal, controller.signal])

    let wakeCode
    let wakeMs = 0
    let ttftTimer
    let stallTimer
    const clearTimers = () => {
      clearTimeout(ttftTimer)
      clearTimeout(stallTimer)
    }
    const armTtft = () => {
      clearTimeout(ttftTimer)
      ttftTimer = setTimeout(() => {
        wakeCode = CODES.TTFT_TIMEOUT
        wakeMs = config.ttftTimeoutMs
        controller.abort()
      }, config.ttftTimeoutMs)
    }
    const armStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        wakeCode = CODES.STALL
        wakeMs = config.stallTimeoutMs
        controller.abort()
      }, config.stallTimeoutMs)
    }
    const totalTimer = setTimeout(() => {
      wakeCode = CODES.TIMEOUT
      wakeMs = config.requestTimeoutMs
      controller.abort()
    }, config.requestTimeoutMs)

    const startedAt = Date.now()
    let ttftMs = 0
    let terminal
    let sawToolCalls = false

    try {
      let extras = { continuationText }
      let request = wire.buildRequest(options, candidate, extras)
      let body
      for (let variant = 0; variant < 2; variant += 1) {
        armTtft()
        try {
          body = await openStream(fetchImpl, {
            ...request,
            signal,
            provider: candidate.provider,
            model: candidate.upstreamModel,
          })
          break
        } catch (error) {
          const failure = error instanceof ProviderFailure ? error.failure : undefined
          const retryableShape = variant === 0
            && failure?.status === 400
            && candidate.wire === 'openai'
            && /stream_options|include_usage/iu.test(failure.message ?? '')
          if (!retryableShape) throw error
          extras = { ...extras, simplified: true }
          request = wire.buildRequest(options, candidate, extras)
        }
      }

      for await (const event of wire.parseResponse(body, {
        signal,
        provider: candidate.provider,
        model: candidate.upstreamModel,
        onActivity: () => {
          if (ttftMs === 0) ttftMs = Math.max(1, Date.now() - startedAt)
          armStall()
        },
      })) {
        switch (event.type) {
          case 'start':
            clearTimeout(ttftTimer)
            armStall()
            break
          case 'text-delta':
            yield* consumeText(state, event.text, { continuation: continuationText !== '', config })
            break
          case 'reasoning-delta':
            if (continuationText === '') {
              if (!state.reasoningOpen) {
                state.reasoningIndex = allocate(state)
                state.reasoningOpen = true
                state.reasoning = ''
                yield { type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' }
              }
              state.reasoning += event.text
              yield { type: 'reasoning-delta', index: state.reasoningIndex, text: event.text }
            }
            break
          case 'tool-call':
            state.toolCalls.push(event)
            sawToolCalls = true
            break
          case 'usage':
            state.usage = event.usage
            break
          case 'end':
            terminal = event
            break
          default:
            break
        }
      }

      if (terminal === undefined) {
        throw new ProviderFailure({
          message: `${candidate.provider}/${candidate.upstreamModel}: the stream ended without a terminal event`,
          code: CODES.STREAM_CLOSED,
        })
      }

      // A buffered window that was never released reveals its nature now.
      if (!state.textOpen && state.pending !== '') {
        if (isDegenerateResponse(state.pending)) {
          throw new ProviderFailure({
            message: `${candidate.provider}/${candidate.upstreamModel}: the model answered with a quota or refusal notice instead of content`,
            code: CODES.DEGENERATE_RESPONSE,
          })
        }
        yield* releasePending(state)
      }

      if (state.text.trim() === '' && state.toolCalls.length === 0 && terminal.sawToolCalls !== true) {
        throw new ProviderFailure({
          message: `${candidate.provider}/${candidate.upstreamModel}: the model returned an empty response`,
          code: CODES.EMPTY_RESPONSE,
        })
      }

      return { finish: terminal.finish, ttftMs: ttftMs === 0 ? Date.now() - startedAt : ttftMs, sawToolCalls }
    } catch (error) {
      if (options.signal?.aborted === true && wakeCode === undefined) {
        throw new ProviderFailure({ message: 'the request was cancelled', code: CODES.ABORTED })
      }
      if (wakeCode !== undefined) {
        throw new ProviderFailure({
          message: wakeCode === CODES.TTFT_TIMEOUT
            ? `${candidate.provider}/${candidate.upstreamModel}: no first byte within ${String(wakeMs)} ms`
            : `${candidate.provider}/${candidate.upstreamModel}: the stream stalled for more than ${String(wakeMs)} ms`,
          code: wakeCode,
        })
      }
      throw error
    } finally {
      clearTimers()
      clearTimeout(totalTimer)
      controller.abort()
    }
  }

  /**
   * Emit one text delta, holding a fresh response until the degenerate window
   * closes.
   * @param {object} state - turn state.
   * @param {string} text - the delta.
   * @param {object} settings - attempt settings.
   * @param {boolean} settings.continuation - whether this attempt continues visible text.
   * @param {object} settings.config - resolved plugin config.
   * @returns {AsyncGenerator<object>} chunks.
   */
  async function* consumeText(state, text, { continuation }) {
    if (continuation || state.textOpen) {
      if (!state.textOpen) {
        state.textIndex = allocate(state)
        state.textOpen = true
        yield { type: 'block-start', index: state.textIndex, blockType: 'text' }
      }
      state.text += text
      state.emittedVisible = true
      yield { type: 'text-delta', index: state.textIndex, text }
      return
    }
    state.pending += text
    if (state.pending.length >= DEGENERATE_WINDOW) {
      yield* releasePending(state)
    }
  }

  /**
   * Release the buffered window as one delta and open the text block.
   * @param {object} state - turn state.
   * @returns {AsyncGenerator<object>} chunks.
   */
  async function* releasePending(state) {
    if (state.pending === '') return
    if (!state.textOpen) {
      state.textIndex = allocate(state)
      state.textOpen = true
      yield { type: 'block-start', index: state.textIndex, blockType: 'text' }
    }
    const text = state.pending
    state.pending = ''
    state.text += text
    state.emittedVisible = true
    yield { type: 'text-delta', index: state.textIndex, text }
  }

  /** Close the open reasoning block, if any. */
  async function* closeReasoning(state) {
    if (!state.reasoningOpen) return
    state.reasoningOpen = false
    yield { type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoning } }
  }

  /**
   * Close every block a failed or cancelled attempt left open.
   * @param {object} state - turn state.
   * @param {boolean} keepText - keep the text block open for a continuation.
   * @returns {AsyncGenerator<object>} chunks.
   */
  async function* closeBlocks(state, keepText) {
    yield* closeReasoning(state)
    if (!state.textOpen || keepText) return
    state.textOpen = false
    yield { type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.text } }
  }

  /** Emit the buffered tail, complete tool calls, usage, and nothing else. */
  async function* finishAttempt(state) {
    if (!state.textOpen && state.pending !== '') yield* releasePending(state)
    yield* closeReasoning(state)
    if (state.textOpen) {
      state.textOpen = false
      yield { type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.text } }
    }
    for (const call of state.toolCalls) {
      const index = allocate(state)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
    }
    if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
  }

  return { stream }
}
