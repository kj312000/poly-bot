class DataBus {
  constructor() {
    this.channels = new Map();
  }

  publish(topic, payload) {
    if (!this.channels.has(topic)) this.channels.set(topic, []);
    this.channels.get(topic).push({
      timestamp: Date.now(),
      ...payload
    });
  }

  subscribe(topic, lookback = 50) {
    const messages = this.channels.get(topic) || [];
    return messages.slice(-lookback);
  }
}

module.exports = DataBus;
