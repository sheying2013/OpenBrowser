use crate::tls::client_hello::is_grease;
use md5::{Digest, Md5};
use sha2::Sha256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ja3Fingerprint {
    pub raw: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ja4Fingerprint {
    pub raw: String,
    pub formatted: String,
}

/// Compute JA3 string and MD5 hash from constituent fields (excluding GREASE values)
pub fn compute_ja3(
    version: u16,
    ciphers: &[u16],
    extensions: &[u16],
    elliptic_curves: &[u16],
    elliptic_curve_point_formats: &[u8],
) -> Ja3Fingerprint {
    let clean_ciphers: Vec<String> = ciphers
        .iter()
        .filter(|&&c| !is_grease(c))
        .map(|c| c.to_string())
        .collect();

    let clean_extensions: Vec<String> = extensions
        .iter()
        .filter(|&&e| !is_grease(e))
        .map(|e| e.to_string())
        .collect();

    let clean_curves: Vec<String> = elliptic_curves
        .iter()
        .filter(|&&g| !is_grease(g))
        .map(|g| g.to_string())
        .collect();

    let clean_formats: Vec<String> = elliptic_curve_point_formats
        .iter()
        .map(|f| f.to_string())
        .collect();

    let raw = format!(
        "{},{},{},{},{}",
        version,
        clean_ciphers.join("-"),
        clean_extensions.join("-"),
        clean_curves.join("-"),
        clean_formats.join("-")
    );

    let mut hasher = Md5::new();
    hasher.update(raw.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    Ja3Fingerprint { raw, hash }
}

/// Compute standard JA4 fingerprint per FoxIO specification.
/// FoxIO Specification:
/// - Part A: {proto}{version}{sni}{cipher_count:2d}{ext_count:2d}{alpn_first_last}
///   - cipher_count: excludes GREASE
///   - ext_count: excludes GREASE only (includes SNI 0x0000 and ALPN 0x0010)
/// - Part B: 12-char truncated SHA-256 of sorted ciphers (excludes GREASE)
/// - Part C: 12-char truncated SHA-256 of sorted extensions (excludes GREASE, SNI 0x0000, and ALPN 0x0010)
///   Followed by signature algorithms in original order if present
pub fn compute_ja4(
    transport: char, // 't' for TCP, 'q' for QUIC
    version: u16,
    has_sni: bool,
    ciphers: &[u16],
    extensions: &[u16],
    alpn: Option<&str>,
) -> Ja4Fingerprint {
    compute_ja4_with_signatures(transport, version, has_sni, ciphers, extensions, None, alpn)
}

/// Compute JA4 fingerprint with signature algorithms (FoxIO JA4 specification)
pub fn compute_ja4_with_signatures(
    transport: char, // 't' for TCP, 'q' for QUIC
    version: u16,
    has_sni: bool,
    ciphers: &[u16],
    extensions: &[u16],
    signature_algorithms: Option<&[u16]>,
    alpn: Option<&str>,
) -> Ja4Fingerprint {
    let clean_ciphers: Vec<u16> = ciphers.iter().copied().filter(|&c| !is_grease(c)).collect();

    // FoxIO Part A ext_count: filter out GREASE only. Includes SNI (0x0000) and ALPN (0x0010).
    let extensions_for_count: Vec<u16> = extensions
        .iter()
        .copied()
        .filter(|&e| !is_grease(e))
        .collect();

    // FoxIO Part C ext_hash: filter out GREASE, SNI (0x0000) and ALPN (0x0010)
    let clean_extensions: Vec<u16> = extensions_for_count
        .iter()
        .copied()
        .filter(|&e| e != 0x0000 && e != 0x0010)
        .collect();

    let ver_str = match version {
        0x0304 => "13",
        0x0303 => "12",
        0x0302 => "11",
        0x0301 => "10",
        _ => "00",
    };

    let sni_char = if has_sni { 'd' } else { 'i' };
    let cipher_count = clean_ciphers.len().min(99);
    let ext_count = extensions_for_count.len().min(99);

    let alpn_code = match alpn.map(str::as_bytes).filter(|bytes| !bytes.is_empty()) {
        Some(bytes) => {
            let first = bytes[0];
            let last = bytes[bytes.len() - 1];
            if first.is_ascii_alphanumeric() && last.is_ascii_alphanumeric() {
                format!("{}{}", first as char, last as char)
            } else {
                format!("{:x}{:x}", first >> 4, last & 0x0f)
            }
        }
        None => "00".to_owned(),
    };

    let part_a = format!(
        "{}{}{}{:02}{:02}{}",
        transport, ver_str, sni_char, cipher_count, ext_count, alpn_code
    );

    // Part b: SHA256 of sorted ciphers truncated to 12 hex chars (or 12 zeros if empty)
    let (part_b, ciphers_str) = if clean_ciphers.is_empty() {
        ("000000000000".to_string(), String::new())
    } else {
        let mut sorted_ciphers = clean_ciphers;
        sorted_ciphers.sort_unstable();
        let c_str = sorted_ciphers
            .iter()
            .map(|c| format!("{:04x}", c))
            .collect::<Vec<_>>()
            .join(",");
        let mut hasher_b = Sha256::new();
        hasher_b.update(c_str.as_bytes());
        (
            format!("{:x}", hasher_b.finalize())[..12].to_string(),
            c_str,
        )
    };

    // Part c: SHA256 of sorted extensions truncated to 12 hex chars (or 12 zeros if empty)
    let (part_c, ext_str) = if clean_extensions.is_empty() {
        ("000000000000".to_string(), String::new())
    } else {
        let mut sorted_extensions = clean_extensions.clone();
        sorted_extensions.sort_unstable();
        let mut ext_str = sorted_extensions
            .iter()
            .map(|e| format!("{:04x}", e))
            .collect::<Vec<_>>()
            .join(",");

        // FoxIO JA4: If signature algorithms (0x000d) is in extensions and provided, append "_sig1,sig2,..."
        let hash_input = if let Some(sigs) = signature_algorithms {
            if clean_extensions.contains(&0x000D) && !sigs.is_empty() {
                let sig_str = sigs
                    .iter()
                    .copied()
                    .filter(|&s| !is_grease(s))
                    .map(|s| format!("{:04x}", s))
                    .collect::<Vec<_>>()
                    .join(",");
                let combined = format!("{}_{}", ext_str, sig_str);
                ext_str = combined.clone();
                combined
            } else {
                ext_str.clone()
            }
        } else {
            ext_str.clone()
        };

        let mut hasher_c = Sha256::new();
        hasher_c.update(hash_input.as_bytes());
        (
            format!("{:x}", hasher_c.finalize())[..12].to_string(),
            ext_str,
        )
    };

    let formatted = format!("{}_{}_{}", part_a, part_b, part_c);
    Ja4Fingerprint {
        raw: format!("{}_{}_{}", part_a, ciphers_str, ext_str),
        formatted,
    }
}
