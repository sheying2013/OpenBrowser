use crate::error::{CoreError, Result};
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use tracing::info;

pub trait ProcessGuardian: Send + Sync {
    /// Supervise a newly spawned child browser PID
    fn register_child(&self, pid: u32) -> Result<()>;

    /// Terminate all tracked child processes
    fn terminate_all(&self) -> Result<()>;
}

#[cfg(windows)]
#[derive(Debug)]
struct SafeJobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for SafeJobHandle {}
#[cfg(windows)]
unsafe impl Sync for SafeJobHandle {}

#[cfg(windows)]
impl Drop for SafeJobHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != -1isize as windows_sys::Win32::Foundation::HANDLE {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

/// Cross-platform process supervisor with true RAII cleanup
#[derive(Debug, Clone)]
pub struct ProcessSupervisor {
    child_pids: Arc<Mutex<Vec<u32>>>,
    #[cfg(windows)]
    job: Option<Arc<SafeJobHandle>>,
}

impl ProcessSupervisor {
    pub fn new() -> Result<Self> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() || job == -1isize as windows_sys::Win32::Foundation::HANDLE {
                return Err(CoreError::Process(format!(
                    "CreateJobObjectW failed: {}",
                    std::io::Error::last_os_error()
                )));
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let res = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };

            if res == 0 {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
                return Err(CoreError::Process(format!(
                    "SetInformationJobObject failed: {}",
                    std::io::Error::last_os_error()
                )));
            }

            Ok(Self {
                child_pids: Arc::new(Mutex::new(Vec::new())),
                job: Some(Arc::new(SafeJobHandle(job))),
            })
        }

        #[cfg(not(windows))]
        {
            Ok(Self {
                child_pids: Arc::new(Mutex::new(Vec::new())),
            })
        }
    }

    /// Number of actively tracked child processes
    pub fn child_count(&self) -> usize {
        self.child_pids.lock().map(|p| p.len()).unwrap_or(0)
    }

    /// List of actively tracked child process PIDs
    pub fn tracked_pids(&self) -> Vec<u32> {
        self.child_pids
            .lock()
            .map(|p| p.clone())
            .unwrap_or_default()
    }
}

impl ProcessGuardian for ProcessSupervisor {
    fn register_child(&self, pid: u32) -> Result<()> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
            };

            if let Some(ref job) = self.job {
                let proc_handle =
                    unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
                if proc_handle.is_null()
                    || proc_handle == -1isize as windows_sys::Win32::Foundation::HANDLE
                {
                    return Err(CoreError::Process(format!(
                        "OpenProcess for pid {} failed: {}",
                        pid,
                        std::io::Error::last_os_error()
                    )));
                }

                let assign_res = unsafe { AssignProcessToJobObject(job.0, proc_handle) };
                unsafe { windows_sys::Win32::Foundation::CloseHandle(proc_handle) };

                if assign_res == 0 {
                    return Err(CoreError::Process(format!(
                        "AssignProcessToJobObject failed for pid {}: {}",
                        pid,
                        std::io::Error::last_os_error()
                    )));
                }
            }

            if let Ok(mut pids) = self.child_pids.lock() {
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
            info!("Registered child process PID into JobObject: {}", pid);
            Ok(())
        }

        #[cfg(not(windows))]
        {
            // Unix process tree lifecycle is actively managed by Browserapp/engine.js.
            // Rust ProcessSupervisor does not own child process handles on Unix; invoking kill() on
            // unowned PIDs poses severe PID-recycling and accidental process termination hazards.
            // Mark explicitly unsupported to avoid unowned termination.
            let _ = pid;
            Err(CoreError::Process(
                "ProcessSupervisor JobObject kernel containment is only supported on Windows; Unix process lifecycle is managed by Browserapp/engine.js".into(),
            ))
        }
    }

    fn terminate_all(&self) -> Result<()> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;
            if let Some(ref job) = self.job {
                unsafe {
                    TerminateJobObject(job.0, 1);
                }
            }
            if let Ok(mut pids) = self.child_pids.lock() {
                pids.clear();
            }
            Ok(())
        }

        #[cfg(not(windows))]
        {
            // Do not invoke kill() on unowned PIDs on Unix to avoid PID-reuse collateral damage.
            Err(CoreError::Process(
                "ProcessSupervisor cannot terminate unowned PIDs on Unix; lifecycle is managed by Browserapp/engine.js".into(),
            ))
        }
    }
}
