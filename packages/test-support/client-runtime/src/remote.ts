/** Test-owned Remote face: `$on` subscriptions and one-generation `$stream` opening. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream, RemoteStreamItem, RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'

// Value re-export for spec-side failure construction: the api-remotes facade
// cannot carry it — its src top-level imports owner /remote lib artifacts, so a
// value import from a spec would load the unbuilt assembly chain.
export { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Remote service test double for the forwarded-event path. Feature specs need
 * `ctx.remote.$on` to exist (their plugins inject `remote`) and need forwarded
 * Host events to reach those subscribers, but not the wire — so this double
 * implements subscription plus an explicit `emit` driver available only on the
 * concrete test object. A spec that also calls one namespace scripts it through
 * the constructor rather than reaching the real Client Remote service.
 *
 * `$mount` rejects: a spec that needs a real generated contribution installed —
 * codecs, descriptors, and the wire — has outgrown this double and needs the
 * real Client Remote service.
 *
 * One deliberate asymmetry with production: a throwing listener propagates out
 * of the emit instead of being contained and logged, so a spec cannot lean on
 * this double for the containment guarantee `$on` documents — assert that
 * against the real service.
 */
export class TestRemote {
  private readonly subscriptions = new Map<string, Set<(...args: never[]) => void>>()

  /**
   * Fixed Host facts mirrored from the production `ctx.remote.$host`. Plain
   * mutable field: a spec assigns it to script a non-loopback or homed Host.
   */
  $host: { home: string | undefined; isLoopback: boolean } = { home: undefined, isLoopback: true }

  /**
   * Register the double as `ctx.remote`, plus one service per scripted
   * namespace so a plugin injecting `remote.<name>` also unparks.
   * @param ctx - the spec's root Context.
   * @param namespaces - scripted namespace faces reached as `ctx.remote.<name>`.
   */
  constructor(private readonly ctx: Context, namespaces: Readonly<Record<string, object>> = {}) {
    this.validateNamespaces(namespaces)
    ctx.provide('remote', this)
    this.installNamespaces(namespaces)
  }

  /**
   * Add scripted namespace faces to this Remote service.
   * @param namespaces - scripted namespace faces reached as `ctx.remote.<name>`.
   */
  provideNamespaces(namespaces: Readonly<Record<string, object>>): void {
    this.validateNamespaces(namespaces)
    this.installNamespaces(namespaces)
  }

  private validateNamespaces(namespaces: Readonly<Record<string, object>>): void {
    for (const name of Object.keys(namespaces)) {
      // A namespace named after one of the double's own members would replace
      // it, and `$mount`'s rejection is the contract a spec relies on.
      if (name in this) {
        throw new TypeError(`TestRemote: scripted namespace "${name}" would shadow the double's own member`)
      }
    }
  }

  private installNamespaces(namespaces: Readonly<Record<string, object>>): void {
    Object.assign(this, namespaces)
    for (const [name, face] of Object.entries(namespaces)) this.ctx.provide(`remote.${name}`, face)
  }

  /**
   * Deliver one forwarded host event to its subscribers, standing in for the
   * carrier that owns the frame sink.
   * @param event - forwarded host event name.
   * @param args - the Host argument list, verbatim.
   */
  emit(event: string, args: readonly unknown[]): void {
    const listeners = this.subscriptions.get(event)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener(...args as never[])
  }

  /**
   * Subscribe to one forwarded host event.
   * @param event - forwarded host event name.
   * @param listener - receives the Host argument list verbatim.
   * @returns disposer removing this subscription.
   */
  $on(event: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.subscriptions.get(event) ?? new Set()
    this.subscriptions.set(event, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  // BEGIN uitstalie-deepseek-flash, 2026/10/28, DH-307, 打开看板/详情需要一代 logical stream，测试替身补 $stream
  /**
   * Open one logical stream over the scripted namespace, without carrier generations.
   *
   * A spec scripts the namespace's own stream method (for example `watch`) and drives the items;
   * this double wraps that iterable so the consumer sees the production item shape. It does not
   * reopen across connections or model `restart`: a spec that needs either has outgrown the double.
   * @param options - the domain opener the consumer passes to the real Client Remote.
   * @returns the logical stream, opened on first iteration.
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    const lifetime = new AbortController()
    const stream = {
      signal: lifetime.signal,
      restart: (): void => { /* one generation in this double */ },
      dispose: async (): Promise<void> => { lifetime.abort() },
      async *[Symbol.asyncIterator](): AsyncGenerator<RemoteStreamItem<Item>> {
        let generation = 0
        for await (const value of options.open(lifetime.signal)) {
          generation += 1
          yield { generation, value, signal: lifetime.signal, accept: (): void => {} }
        }
        throw options.ended(true)
      },
    }
    return stream as unknown as RemoteStream<Item>
  }
  // END uitstalie-deepseek-flash

  /**
   * Generated-namespace mount, unsupported by this double.
   * @returns never; always rejects.
   */
  $mount(): Promise<() => Promise<void>> {
    return Promise.reject(new Error('TestRemote: $mount needs the real Client Remote service'))
  }
}
