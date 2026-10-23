use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn invoke(args: &[&str], input: &[u8]) -> (bool, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_openbrowser-core"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let payload = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&payload);
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("CLI deadline");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    writer.join().unwrap();
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    (status.success(), stdout, stderr)
}

#[test]
fn version_capabilities_are_explicit() {
    let (ok, output, _) = invoke(&["version"], b"");
    assert!(ok);
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["control_protocol"], 1);
    assert!(!value["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x == "https-upstream"));
}

#[test]
fn private_first_frame_then_stop_or_eof() {
    let config = br#"{"protocol":"socks5","host":"127.0.0.1","port":9,"username":"synthetic-user","password":"synthetic-password"}"#;
    for suffix in [b"\nstop\n".as_slice(), b"\n".as_slice()] {
        let mut input = config.to_vec();
        input.extend_from_slice(suffix);
        let (ok, output, errors) = invoke(&["bridge"], &input);
        assert!(ok, "{errors}");
        let lines: Vec<Value> = output
            .lines()
            .map(|x| serde_json::from_str(x).unwrap())
            .collect();
        assert_eq!(lines[0]["status"], "listening");
        assert_eq!(lines[1]["status"], "stopped");
        assert!(!output.contains("synthetic-password"));
        assert!(!errors.contains("synthetic-password"));
    }
}

#[test]
fn malformed_missing_oversized_frames_and_argv_config_fail() {
    for input in [b"".to_vec(), b"not-json\n".to_vec(), vec![b'a'; 65_537]] {
        let (ok, _, _) = invoke(&["bridge"], &input);
        assert!(!ok);
    }
    assert!(!invoke(&["bridge", "--config", "{}"], b"").0);
}

#[test]
fn layout_preserves_zero_and_rejects_invalid_arguments() {
    let (ok, output, _) = invoke(
        &[
            "layout",
            "--count",
            "0",
            "--taskbar",
            "0",
            "--margin",
            "0",
            "--gap",
            "0",
        ],
        b"",
    );
    assert!(ok);
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["count"], 0);
    assert_eq!(value["screen"]["taskbar"], 0);
    assert!(value["windows"].as_array().unwrap().is_empty());
    for args in [
        vec!["layout", "--count", "-1"],
        vec!["layout", "--count"],
        vec!["layout", "--count", "3", "--count", "4"],
        vec!["layout", "--unknown", "1"],
    ] {
        assert!(!invoke(&args, b"").0);
    }
}
