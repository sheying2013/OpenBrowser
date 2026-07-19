(function attachEnvironmentAudit(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EnvironmentAudit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEnvironmentAudit() {
  'use strict';

  function text(value) { return String(value ?? '').trim(); }
  function isDirect(proxy) { return !text(proxy) || /^(direct|offline|none)$/i.test(text(proxy)); }
  function item(id, label, state, detail) { return { id, label, state, detail }; }

  function build(profile, options = {}) {
    const value = profile && typeof profile === 'object' ? profile : {};
    const privacy = value.privacy && typeof value.privacy === 'object' ? value.privacy : {};
    const advanced = value.advanced && typeof value.advanced === 'object' ? value.advanced : {};
    const checks = [];
    const direct = isDirect(value.proxy);

    checks.push(item('profile', '独立 Profile', value.id ? 'pass' : 'warn', value.id ? `独立目录：${text(value.id)}` : '缺少环境 ID，无法确认数据隔离'));
    checks.push(item('storage', '持久化数据', 'info', [
      advanced.saveCookies !== false ? 'Cookie' : '',
      advanced.saveLocalStorage !== false ? 'LocalStorage' : '',
      advanced.saveIndexedDB !== false ? 'IndexedDB' : '',
      advanced.saveHistory !== false ? '历史记录' : ''
    ].filter(Boolean).join('、') || '启动后不保留主要站点数据'));

    if (direct) checks.push(item('proxy', '网络出口', 'info', '本地直连；使用本机公网出口'));
    else if (text(value.exitIp)) checks.push(item('proxy', '网络出口', 'pass', `代理已检测：${text(value.exitIp)}${text(value.exitCountryCode) ? ` (${text(value.exitCountryCode)})` : ''}`));
    else checks.push(item('proxy', '网络出口', 'warn', '代理尚未完成出口检测；时区和地理位置不能自动核对'));

    if (privacy.timezoneMode === 'ip') checks.push(item('timezone', '时区', text(value.exitTimezone) ? 'pass' : 'warn', text(value.exitTimezone) || '等待代理出口检测后匹配'));
    else if (privacy.timezoneMode === 'custom') checks.push(item('timezone', '时区', text(privacy.timezone) ? 'info' : 'warn', text(privacy.timezone) || '自定义时区为空'));
    else checks.push(item('timezone', '时区', 'pass', text(options.systemTimezone) || '跟随操作系统'));

    if (privacy.geoMode === 'ip') {
      const ready = Number.isFinite(Number(value.exitLatitude)) && Number.isFinite(Number(value.exitLongitude));
      checks.push(item('geo', '地理位置', ready ? 'pass' : 'warn', ready ? '使用已检测代理坐标' : '没有已验证的代理坐标'));
    } else if (privacy.geoMode === 'custom') checks.push(item('geo', '地理位置', 'info', '使用测试坐标；这属于标准浏览器兼容性模拟'));
    else checks.push(item('geo', '地理位置', 'pass', '网站定位权限已禁止'));

    const webrtc = text(privacy.webrtc) || 'proxy';
    if (webrtc === 'real' && !direct) checks.push(item('webrtc', 'WebRTC', 'warn', '代理环境允许真实网络，可能暴露非代理候选地址'));
    else if (webrtc === 'proxy' && direct) checks.push(item('webrtc', 'WebRTC', 'info', '当前是本地直连，代理限制不会改变公网出口'));
    else checks.push(item('webrtc', 'WebRTC', 'pass', webrtc === 'real' ? '使用系统真实网络' : '已限制非代理 UDP'));

    checks.push(item('ua', 'User-Agent', text(value.userAgent) ? 'pass' : 'info', text(value.userAgent)
      ? '已设置自定义 UA（启动时同步 Client Hints / sec-ch-ua / userAgentData）'
      : '留空则按环境 ID 自动生成 UA + Client Hints'));
    checks.push(item('os', '操作系统', !text(value.os) || /^windows$/i.test(text(value.os)) ? 'pass' : 'warn', /^windows$/i.test(text(value.os)) || !text(value.os) ? 'Windows 真实主机' : `${text(value.os)} 仅是测试标签，不会把 Windows 变成真实设备`));
    checks.push(item('graphics', '图形接口', 'info', `Canvas ${privacy.canvas === 'blocked' ? '禁止读取' : '真实'}；WebGL ${privacy.webgl === 'blocked' ? '禁用' : '真实'}；WebGPU ${privacy.webgpu === 'blocked' ? '禁用' : '真实'}`));
    checks.push(item('media', '媒体设备', privacy.media === 'blocked' ? 'pass' : 'info', privacy.media === 'blocked' ? '摄像头和麦克风权限已禁止' : '由网站按标准权限流程询问'));
    checks.push(item('fingerprint', '指纹覆盖边界', 'info', 'Canvas、WebGL、Audio 和 ClientRects 仅提供 JS 层可选噪声或禁用；WebGPU、字体、真实 GPU、Worker、TLS 与网络指纹未被完整伪造，本报告不承诺规避高级平台关联检测'));

    const warnings = checks.filter((check) => check.state === 'warn').length;
    return {
      version: 1,
      status: warnings ? 'review' : 'ready',
      warnings,
      checks,
      profileRoot: text(options.profileRoot)
    };
  }

  return Object.freeze({ build, isDirect });
});
