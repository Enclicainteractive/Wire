/**
 * Collection — a Map subclass with Array-like helpers.
 * Used internally for server/channel/member caches.
 */
export class Collection extends Map {
  /** Return the first entry matching the predicate. */
  find(fn) {
    for (const val of this.values()) {
      if (fn(val)) return val
    }
    return undefined
  }

  /** Return all entries matching the predicate as an array. */
  filter(fn) {
    const result = []
    for (const val of this.values()) {
      if (fn(val)) result.push(val)
    }
    return result
  }

  /** Map values to a new array. */
  map(fn) {
    const result = []
    for (const val of this.values()) result.push(fn(val))
    return result
  }

  /** Return true if any entry matches the predicate. */
  some(fn) {
    for (const val of this.values()) {
      if (fn(val)) return true
    }
    return false
  }

  /** Return true if every entry matches the predicate. */
  every(fn) {
    for (const val of this.values()) {
      if (!fn(val)) return false
    }
    return true
  }

  /** Reduce values to a single result. */
  reduce(fn, initial) {
    let acc = initial
    for (const val of this.values()) acc = fn(acc, val)
    return acc
  }

  /** Return values as an array. */
  toArray() {
    return [...this.values()]
  }

  /** Return the first value. */
  first() {
    return this.values().next().value
  }

  /** Return the last value. */
  last() {
    const arr = this.toArray()
    return arr[arr.length - 1]
  }

  /** Return a random value. */
  random() {
    const arr = this.toArray()
    return arr[Math.floor(Math.random() * arr.length)]
  }
}
