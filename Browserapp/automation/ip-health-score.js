'use strict';

const SCORE_MAX = 100;
const SCORE_MIN = 0;

function asBoolean(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
}

function normalizeNetworkType(network = {}) {
  return String(network.networkType || network.type || '').trim().toLowerCase();
}

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function riskIntelData(network = {}) {
  const nested = network.riskIntel || network.ipPure || network.ippure || {};
  const fraudScore = finitePercent(
    nested.fraudScore ?? nested.riskScore ?? network.ippureFraudScore ?? network.fraudScore,
  );
  const isResidential = nested.isResidential ?? network.isResidential;
  const isBroadcast = nested.isBroadcast ?? network.isBroadcast;
  return {
    fraudScore,
    isResidential: typeof isResidential === 'boolean' ? isResidential : null,
    isBroadcast: typeof isBroadcast === 'boolean' ? isBroadcast : null,
    asOrganization: String(nested.asOrganization || network.ippureAsOrganization || '').trim(),
  };
}

function calculateIpHealthScore(network = {}) {
  const ip = String(network.ip || network.query || '').trim();
  if (!ip) {
    return {
      score: null,
      level: 'unknown',
      label: '待检测',
      confidence: 'low',
      factors: [{
        code: 'network-unavailable',
        state: 'neutral',
        impact: 0,
        label: '尚未取得出口 IP',
        detail: '刷新出口检测后再计算 IP 健康评分。',
      }],
    };
  }

  const proxy = asBoolean(network.proxy) || normalizeNetworkType(network) === 'proxy';
  const risk = riskIntelData(network);
  const hosting = asBoolean(network.hosting)
    || normalizeNetworkType(network) === 'hosting'
    || (risk.isResidential === false && risk.isBroadcast === false);
  const mobile = asBoolean(network.mobile) || normalizeNetworkType(network) === 'mobile';
  const geoConflict = asBoolean(network.geoConflict)
    || (Array.isArray(network.countries) && new Set(network.countries.filter(Boolean)).size > 1);
  const factors = [];
  const hasRiskScore = risk.fraudScore != null;
  let score = hasRiskScore ? SCORE_MAX - risk.fraudScore : 70;

  if (hasRiskScore) {
    const riskLabel = risk.fraudScore >= 70 ? '高风险' : risk.fraudScore >= 40 ? '中度风险' : '低风险';
    factors.push({
      code: 'risk-score',
      state: risk.fraudScore >= 70 ? 'bad' : risk.fraudScore >= 40 ? 'warn' : 'good',
      impact: -risk.fraudScore,
      label: `风险系数 ${risk.fraudScore}%（${riskLabel}）`,
      detail: '综合风险信号已计入评分；仅供本地参考，不代表任何站点的账号可用性。',
    });
  }

  if (geoConflict) {
    score -= 12;
    const usage = String(network.countryUsage || '').toUpperCase();
    const registered = String(network.countryRegistered || '').toUpperCase();
    const countries = Array.isArray(network.countries)
      ? network.countries.map((item) => String(item || '').toUpperCase()).filter(Boolean)
      : [];
    factors.push({
      code: 'geo-conflict',
      state: 'warn',
      impact: -12,
      label: '注册地与使用地不一致',
      detail: network.countryNote
        || `多源地区结果不一致：${countries.join(' / ') || [registered, usage].filter(Boolean).join(' / ') || '未知'}。常见于广播/Anycast 或注册地与实际出口不同的线路。`,
    });
  }

  if (proxy && hosting && !hasRiskScore) {
    score -= 45;
    factors.push({
      code: 'proxy-hosting',
      state: 'bad',
      impact: -45,
      label: '代理 / 托管标记',
      detail: '出口查询同时标记为代理或 VPN，以及托管/机房网络。',
    });
  } else if (proxy && !hasRiskScore) {
    score -= 35;
    factors.push({
      code: 'proxy',
      state: 'bad',
      impact: -35,
      label: '代理 / VPN 标记',
      detail: '出口查询将此 IP 标记为代理或 VPN；这不是对代理用途本身的否定。',
    });
  } else if (hosting && !hasRiskScore) {
    score -= 28;
    factors.push({
      code: 'hosting',
      state: 'bad',
      impact: -28,
      label: '托管 / 机房网络',
      detail: '出口查询将此 IP 归为托管或数据中心网络。',
    });
  } else if (!hasRiskScore) {
    factors.push({
      code: 'no-datacenter-flag',
      state: 'good',
      impact: 0,
      label: '未发现代理或机房标记',
      detail: '当前出口查询没有返回代理、VPN 或托管网络标记。',
    });
  }

  if (hasRiskScore && hosting) {
    factors.push({
      code: 'non-residential',
      state: 'bad',
      impact: 0,
      label: '非住宅 / 机房属性',
      detail: '风险情报未将此 IP 识别为住宅网络；该信号已由风险系数综合反映，避免重复扣分。',
    });
  }

  if (hasRiskScore && risk.isBroadcast === true) {
    factors.push({
      code: 'broadcast',
      state: 'warn',
      impact: 0,
      label: '广播 / 共享出口特征',
      detail: '该出口更像广播或共享线路，地区标签可能与注册地不同。',
    });
  }

  if (mobile) {
    score -= 3;
    factors.push({
      code: 'mobile',
      state: 'warn',
      impact: -3,
      label: '移动网络',
      detail: '移动网络地址可能共享出口，评分仅作风险提示，不等同于恶意。',
    });
  }

  const missing = [];
  if (!String(network.countryCode || network.country || '').trim()) missing.push('地区');
  if (!String(network.asn || network.asName || '').trim()) missing.push('ASN');
  if (missing.length) {
    factors.push({
      code: 'incomplete',
      state: 'neutral',
      impact: 0,
      label: '数据尚不完整',
      detail: `未返回${missing.join('、')}，不因此扣分；评分置信度降低。`,
    });
  }

  // Intentionally do NOT surface "risk data unavailable" or provider names in UI.
  // Missing risk intel is already reflected by lower confidence.

  score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, score));
  const level = score >= 80 ? 'healthy' : score >= 50 ? 'review' : 'risky';
  const label = level === 'healthy' ? '健康' : level === 'review' ? '需复核' : '高风险';
  const confidence = hasRiskScore
    ? (missing.length || geoConflict ? 'medium' : 'high')
    : (geoConflict ? 'medium' : 'low');

  return { score, level, label, confidence, factors };
}

module.exports = { calculateIpHealthScore };
