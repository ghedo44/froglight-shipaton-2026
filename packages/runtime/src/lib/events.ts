/**
 * Typed extension events with explicit semantics.
 *
 * Any active fiber may emit an extension event; subscribers receive it.
 *
 * Event names and payloads are governed by one event map type so handlers and
 * emitters cannot drift apart through unrelated structural casts.
 *
 * The event bus is generic composition infrastructure: events carry a typed
 * payload and are not product concepts.
 */

/**
 * A map of event type names to payload types. The default map accepts any
 * string type with an `unknown` payload; applications may declare a narrower
 * map to govern their event surface.
 */
export interface EventMap {
  [type: string]: unknown;
}

/**
 * A typed event bus shared by the runtime. Events are broadcast to all
 * currently subscribed handlers; handlers are called synchronously in
 * subscription order.
 */
export interface EventBus<E extends EventMap = EventMap> {
  /** Subscribe to an event type. Returns a handle that removes the listener. */
  on<K extends keyof E & string>(
    type: K,
    handler: (payload: E[K]) => void,
  ): EventSubscription;
  /** Emit an event to all current subscribers of its type. */
  emit<K extends keyof E & string>(type: K, payload: E[K]): void;
  /** Number of active subscriptions, for introspection. */
  readonly subscriptionCount: number;
}

/** A handle that removes an event subscription. */
export interface EventSubscription {
  readonly dispose: () => void;
}

/** Internal record of a subscription, used for introspection. */
export interface SubscriptionRecord {
  readonly type: string;
  readonly handler: (payload: unknown) => void;
}

/** Broadcast event bus implementation. */
export class BroadcastBus<E extends EventMap = EventMap>
  implements EventBus<E>
{
  #subscriptions = new Map<string, Set<SubscriptionRecord>>();

  get subscriptionCount(): number {
    let count = 0;
    for (const set of this.#subscriptions.values()) {
      count += set.size;
    }
    return count;
  }

  on<K extends keyof E & string>(
    type: K,
    handler: (payload: E[K]) => void,
  ): EventSubscription {
    let set = this.#subscriptions.get(type);
    if (!set) {
      set = new Set();
      this.#subscriptions.set(type, set);
    }
    const record: SubscriptionRecord = {
      type,
      handler: handler as (payload: unknown) => void,
    };
    set.add(record);
    return {
      dispose: () => {
        set.delete(record);
        if (set.size === 0) {
          this.#subscriptions.delete(type);
        }
      },
    };
  }

  emit<K extends keyof E & string>(type: K, payload: E[K]): void {
    const set = this.#subscriptions.get(type);
    if (!set) {
      return;
    }
    for (const record of [...set]) {
      record.handler(payload);
    }
  }

  /** All active subscriptions (for introspection and leak assertions). */
  records(): readonly SubscriptionRecord[] {
    const all: SubscriptionRecord[] = [];
    for (const set of this.#subscriptions.values()) {
      for (const record of set) {
        all.push(record);
      }
    }
    return all;
  }
}
