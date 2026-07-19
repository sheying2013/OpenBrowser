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

function ipPureData(network = {}) {
  const nested = network.ipPure || network.ippure || {};
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
  const ipPure = ipPureData(network);
  const hosting = asBoolean(network.hosting)
    || normalizeNetworkType(network) === 'hosting'
    || (ipPure.isResidential === false && ipPure.isBroadcast === false);
  const mobile = asBoolean(network.mobile) || normalizeNetworkType(network) === 'mobile';
  const factors = [];
  const hasIpPureScore = ipPure.fraudScore != null;
  let score = hasIpPureScore ? SCORE_MAX - ipPure.fraudScore : 70;

  if (hasIpPureScore) {
    const riskLabel = ipPure.fraudScore >= 70 ? '高风险' : ipPure.fraudScore >= 40 ? '中度风险' : '低风险';
    factors.push({
      code: 'ippure-risk',
      state: ipPure.fraudScore >= 70 ? 'bad' : ipPure.fraudScore >= 40 ? 'warn' : 'good',
      impact: -ipPure.fraudScore,
      label: `IPPure 风险系数 ${ipPure.fraudScore}%（${riskLabel}）`,
      detail: '该数值来自 IPPure 公开接口；本地健康分按 100 - 风险系数计算，不代表商业数据库官方健康分。',
    });
  }

  if (proxy && hosting && !hasIpPureScore) {
    score -= 45;
    factors.push({
      code: 'proxy-hosting',
      state: 'bad',
      impact: -45,
      label: '代理 / 托管标记',
      detail: '出口查询同时标记为代理或 VPN，以及托管/机房网络。',
    });
  } else if (proxy && !hasIpPureScore) {
    score -= 35;
    factors.push({
      code: 'proxy',
      state: 'bad',
      impact: -35,
      label: '代理 / VPN 标记',
      detail: '出口查询将此 IP 标记为代理或 VPN；这不是对代理用途本身的否定。',
    });
  } else if (hosting && !hasIpPureScore) {
    score -= 28;
    factors.push({
      code: 'hosting',
      state: 'bad',
      impact: -28,
      label: '托管 / 机房网络',
      detail: '出口查询将此 IP 归为托管或数据中心网络。',
    });
  } else if (!hasIpPureScore) {
    factors.push({
      code: 'no-datacenter-flag',
      state: 'good',
      impact: 0,
      label: '未发现代理或机房标记',
      detail: '当前出口查询没有返回代理、VPN 或托管网络标记。',
    });
  }

  if (hasIpPureScore && hosting) {
    factors.push({
      code: 'ippure-non-residential',
      state: 'bad',
      impact: 0,
      label: 'IPPure：非住宅 / 机房属性',
      detail: 'IPPure 未将此 IP 识别为住宅网络；该信号已由风险系数综合反映，避免重复扣分。',
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

  if (!hasIpPureScore) {
    factors.push({
      code: 'ippure-unavailable',
      state: 'neutral',
      impact: 0,
      label: 'IPPure 风险数据不可用',
      detail: '未取得 IPPure 风险系数；当前分数只是基础网络信号评估，不能视为完整 IP 健康结论。',
    });
  }

  score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, score));
  const level = score >= 80 ? 'healthy' : score >= 50 ? 'review' : 'risky';
  const label = level === 'healthy' ? '健康' : level === 'review' ? '需复核' : '高风险';
  const confidence = hasIpPureScore ? (missing.length ? 'medium' : 'high') : 'low';

  return { score, level, label, confidence, factors };
}

module.exports = { calculateIpHealthScore };
