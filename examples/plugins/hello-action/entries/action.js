'use strict'

module.exports = {
  async run(context, input) {
    const accounts = await streamfold.data.read('accounts', { limit: 3 })
    const count = Array.isArray(accounts) ? accounts.length : 0
    const requestedName = input && typeof input === 'object' && typeof input.name === 'string'
      ? input.name
      : '归页用户'
    return {
      ok: true,
      pluginId: context.pluginId || null,
      message: `你好，${requestedName}！已读取 ${count} 个授权账号摘要。`
    }
  }
}
