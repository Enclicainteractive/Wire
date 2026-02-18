export class EventEmitter {
  constructor() {
    this._listeners = {}
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(fn)
    return this
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper)
      fn(...args)
    }
    wrapper._original = fn
    return this.on(event, wrapper)
  }

  off(event, fn) {
    if (!this._listeners[event]) return this
    this._listeners[event] = this._listeners[event].filter(
      f => f !== fn && f._original !== fn
    )
    return this
  }

  emit(event, ...args) {
    const fns = this._listeners[event]
    if (!fns?.length) return false
    for (const fn of fns) fn(...args)
    return true
  }

  removeAllListeners(event) {
    if (event) {
      delete this._listeners[event]
    } else {
      this._listeners = {}
    }
    return this
  }
}
