import { EventEmitter } from './EventEmitter.js'

export class BotUIComponent {
  constructor(type, options = {}) {
    this.type = type
    this.id = options.id || `ui_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    this.styles = options.styles || {}
    this.disabled = options.disabled || false
    this.hidden = options.hidden || false
  }

  toJSON() {
    return {
      type: this.type,
      id: this.id,
      styles: this.styles,
      disabled: this.disabled,
      hidden: this.hidden
    }
  }
}

export class BotButton extends BotUIComponent {
  constructor(options = {}) {
    super('button', options)
    this.label = options.label || 'Button'
    this.emoji = options.emoji || null
    this.variant = options.variant || 'primary'
    this.action = options.action || null
    this.confirm = options.confirm || null
    this.url = options.url || null
  }

  setLabel(label) {
    this.label = label
    return this
  }

  setEmoji(emoji) {
    this.emoji = emoji
    return this
  }

  setVariant(variant) {
    this.variant = variant
    return this
  }

  setAction(action) {
    this.action = action
    return this
  }

  setConfirm(message) {
    this.confirm = { message }
    return this
  }

  setUrl(url) {
    this.url = url
    return this
  }

  disable() {
    this.disabled = true
    return this
  }

  enable() {
    this.disabled = false
    return this
  }

  hide() {
    this.hidden = true
    return this
  }

  show() {
    this.hidden = false
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      label: this.label,
      emoji: this.emoji,
      variant: this.variant,
      action: this.action,
      confirm: this.confirm,
      url: this.url
    }
  }
}

export class BotInput extends BotUIComponent {
  constructor(options = {}) {
    super('input', options)
    this.placeholder = options.placeholder || ''
    this.value = options.value || ''
    this.label = options.label || null
    this.minLength = options.minLength || null
    this.maxLength = options.maxLength || null
    this.required = options.required || false
    this.action = options.action || null
  }

  setPlaceholder(placeholder) {
    this.placeholder = placeholder
    return this
  }

  setValue(value) {
    this.value = value
    return this
  }

  setLabel(label) {
    this.label = label
    return this
  }

  setMinLength(min) {
    this.minLength = min
    return this
  }

  setMaxLength(max) {
    this.maxLength = max
    return this
  }

  setRequired(required = true) {
    this.required = required
    return this
  }

  setAction(action) {
    this.action = action
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      placeholder: this.placeholder,
      value: this.value,
      label: this.label,
      minLength: this.minLength,
      maxLength: this.maxLength,
      required: this.required,
      action: this.action
    }
  }
}

export class BotSelect extends BotUIComponent {
  constructor(options = {}) {
    super('select', options)
    this.placeholder = options.placeholder || 'Select an option'
    this.options = options.options || []
    this.multiple = options.multiple || false
    this.action = options.action || null
  }

  addOption(value, label, emoji = null) {
    this.options.push({ value, label, emoji })
    return this
  }

  setPlaceholder(placeholder) {
    this.placeholder = placeholder
    return this
  }

  setMultiple(multiple = true) {
    this.multiple = multiple
    return this
  }

  setAction(action) {
    this.action = action
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      placeholder: this.placeholder,
      options: this.options,
      multiple: this.multiple,
      action: this.action
    }
  }
}

export class BotCanvas extends BotUIComponent {
  constructor(options = {}) {
    super('canvas', options)
    this.width = options.width || 300
    this.height = options.height || 200
    this.pixels = options.pixels || []
    this.interactive = options.interactive || false
    this.action = options.action || null
  }

  setSize(width, height) {
    this.width = width
    this.height = height
    return this
  }

  setPixel(x, y, color) {
    this.pixels.push({ x, y, color })
    return this
  }

  setPixels(pixels) {
    this.pixels = pixels
    return this
  }

  clear() {
    this.pixels = []
    return this
  }

  setInteractive(interactive = true) {
    this.interactive = interactive
    return this
  }

  setAction(action) {
    this.action = action
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      width: this.width,
      height: this.height,
      pixels: this.pixels,
      interactive: this.interactive,
      action: this.action
    }
  }
}

export class BotText extends BotUIComponent {
  constructor(options = {}) {
    super('text', options)
    this.content = options.content || ''
    this.format = options.format || 'plain'
  }

  setContent(content) {
    this.content = content
    return this
  }

  setFormat(format) {
    this.format = format
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      content: this.content,
      format: this.format
    }
  }
}

export class BotImage extends BotUIComponent {
  constructor(options = {}) {
    super('image', options)
    this.url = options.url || ''
    this.alt = options.alt || 'Image'
    this.action = options.action || null
  }

  setUrl(url) {
    this.url = url
    return this
  }

  setAlt(alt) {
    this.alt = alt
    return this
  }

  setAction(action) {
    this.action = action
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      url: this.url,
      alt: this.alt,
      action: this.action
    }
  }
}

export class BotDivider extends BotUIComponent {
  constructor(options = {}) {
    super('divider', options)
    this.style = options.style || 'solid'
  }

  setStyle(style) {
    this.style = style
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      style: this.style
    }
  }
}

export class BotSpacer extends BotUIComponent {
  constructor(options = {}) {
    super('spacer', options)
    this.size = options.size || 'medium'
  }

  setSize(size) {
    this.size = size
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      size: this.size
    }
  }
}

export class BotActionRow extends BotUIComponent {
  constructor(options = {}) {
    super('actionRow', options)
    this.components = []
  }

  addButton(options = {}) {
    const button = new BotButton(options)
    this.components.push(button)
    return this
  }

  addInput(options = {}) {
    const input = new BotInput(options)
    this.components.push(input)
    return this
  }

  addSelect(options = {}) {
    const select = new BotSelect(options)
    this.components.push(select)
    return this
  }

  toJSON() {
    return {
      ...super.toJSON(),
      components: this.components.map(c => c.toJSON())
    }
  }
}

export class InteractiveMessage extends EventEmitter {
  constructor() {
    super()
    this.content = ''
    this.embeds = []
    this.components = []
    this.uiElements = []
    this.canvas = null
    this._messageId = null
    this._channelId = null
    this._interactions = new Map()
  }

  setContent(content) {
    this.content = content
    return this
  }

  addEmbed(embed) {
    this.embeds.push(embed)
    return this
  }

  addButton(options = {}) {
    const button = new BotButton(options)
    this.uiElements.push(button)
    return button
  }

  addInput(options = {}) {
    const input = new BotInput(options)
    this.uiElements.push(input)
    return input
  }

  addSelect(options = {}) {
    const select = new BotSelect(options)
    this.uiElements.push(select)
    return select
  }

  addCanvas(options = {}) {
    const canvas = new BotCanvas(options)
    this.canvas = canvas
    return canvas
  }

  addText(options = {}) {
    const text = new BotText(options)
    this.uiElements.push(text)
    return text
  }

  addImage(options = {}) {
    const image = new BotImage(options)
    this.uiElements.push(image)
    return image
  }

  addDivider(options = {}) {
    const divider = new BotDivider(options)
    this.uiElements.push(divider)
    return this
  }

  addSpacer(options = {}) {
    const spacer = new BotSpacer(options)
    this.uiElements.push(spacer)
    return this
  }

  addActionRow() {
    const row = new BotActionRow()
    this.components.push(row)
    return row
  }

  onInteraction(callback) {
    this.on('interaction', callback)
  }

  _handleInteraction(data) {
    const { componentId, action, value, userId } = data
    this.emit('interaction', {
      componentId,
      action,
      value,
      userId,
      messageId: this._messageId,
      channelId: this._channelId
    })
  }

  toJSON() {
    return {
      content: this.content,
      embeds: this.embeds,
      components: this.components.map(c => c.toJSON()),
      ui: {
        elements: this.uiElements.map(e => e.toJSON()),
        canvas: this.canvas?.toJSON() || null
      }
    }
  }

  toMessagePayload() {
    const payload = {}
    
    if (this.content) {
      payload.content = this.content
    }
    
    if (this.embeds.length > 0) {
      payload.embeds = this.embeds
    }
    
    if (this.components.length > 0 || this.uiElements.length > 0 || this.canvas) {
      payload.ui = {
        components: this.components.map(c => c.toJSON()),
        elements: this.uiElements.map(e => e.toJSON()),
        canvas: this.canvas?.toJSON() || null
      }
    }
    
    return payload
  }
}

export class InteractiveMessageManager extends EventEmitter {
  constructor(client) {
    super()
    this.client = client
    this._messages = new Map()
    this._handlers = new Map()
    
    this._setupListeners()
  }

  _setupListeners() {
    this.client.on('ui:interaction', this._handleInteraction.bind(this))
    this.client.on('ui:buttonClick', this._handleButtonClick.bind(this))
    this.client.on('ui:inputSubmit', this._handleInputSubmit.bind(this))
    this.client.on('ui:selectChange', this._handleSelectChange.bind(this))
    this.client.on('ui:canvasClick', this._handleCanvasClick.bind(this))
  }

  _handleInteraction(data) {
    const { messageId, componentId, action, value, userId } = data
    const message = this._messages.get(messageId)
    if (message) {
      message._handleInteraction({ componentId, action, value, userId })
    }
    this.emit('interaction', data)
  }

  _handleButtonClick(data) {
    this.emit('buttonClick', data)
  }

  _handleInputSubmit(data) {
    this.emit('inputSubmit', data)
  }

  _handleSelectChange(data) {
    this.emit('selectChange', data)
  }

  _handleCanvasClick(data) {
    this.emit('canvasClick', data)
  }

  create() {
    const message = new InteractiveMessage()
    return message
  }

  track(messageId, message) {
    this._messages.set(messageId, message)
    message._messageId = messageId
    return message
  }

  untrack(messageId) {
    this._messages.delete(messageId)
  }

  onButtonClick(callback) {
    this.on('buttonClick', callback)
  }

  onInputSubmit(callback) {
    this.on('inputSubmit', callback)
  }

  onSelectChange(callback) {
    this.on('selectChange', callback)
  }

  onCanvasClick(callback) {
    this.on('canvasClick', callback)
  }

  onAnyInteraction(callback) {
    this.on('interaction', callback)
  }
}
