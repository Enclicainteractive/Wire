export class Embed {
  constructor(data = {}) {
    this.title = data.title || null
    this.description = data.description || null
    this.color = data.color || null
    this.url = data.url || null
    this.timestamp = data.timestamp || null
    this.footer = data.footer || null
    this.image = data.image || null
    this.thumbnail = data.thumbnail || null
    this.author = data.author || null
    this.fields = data.fields || []
  }

  setTitle(title) {
    this.title = title
    return this
  }

  setDescription(description) {
    this.description = description
    return this
  }

  setColor(color) {
    this.color = color
    return this
  }

  setURL(url) {
    this.url = url
    return this
  }

  setTimestamp(date) {
    this.timestamp = (date || new Date()).toISOString()
    return this
  }

  setFooter(text, iconUrl) {
    this.footer = { text, iconUrl }
    return this
  }

  setImage(url) {
    this.image = { url }
    return this
  }

  setThumbnail(url) {
    this.thumbnail = { url }
    return this
  }

  setAuthor(name, iconUrl, url) {
    this.author = { name, iconUrl, url }
    return this
  }

  addField(name, value, inline = false) {
    this.fields.push({ name, value, inline })
    return this
  }

  toJSON() {
    return {
      title: this.title,
      description: this.description,
      color: this.color,
      url: this.url,
      timestamp: this.timestamp,
      footer: this.footer,
      image: this.image,
      thumbnail: this.thumbnail,
      author: this.author,
      fields: this.fields
    }
  }
}
