//! Windows tunnel tree ownership, established before the leader executes.
use std::{
    ops::{Deref, DerefMut},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command, ExitStatus},
    time::Duration,
};
use windows::Win32::{
    Foundation::{HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32,
            TH32CS_SNAPTHREAD,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenThread, ResumeThread, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            THREAD_SUSPEND_RESUME,
        },
    },
};

pub(super) struct OwnedChild {
    child: Child,
    // Non-inherited and never duplicated. Closing the last handle kills the tree.
    job: OwnedHandle,
}

impl OwnedChild {
    pub(super) fn spawn(command: &mut Command) -> Result<Self, String> {
        // SAFETY: FFI boundary: null attributes/name create a private non-inherited
        // job. The successful handle is transferred exactly once to OwnedHandle.
        let job = unsafe {
            let handle = CreateJobObjectW(None, None)
                .map_err(|error| format!("failed to create tunnel job: {error}"))?;
            OwnedHandle::from_raw_handle(handle.0)
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = u32::try_from(std::mem::size_of_val(&limits))
            .map_err(|error| error.to_string())?;
        // SAFETY: FFI layout/lifetime: initialized Windows structure, exact size;
        // job and structure remain alive for the synchronous call.
        unsafe {
            SetInformationJobObject(
                HANDLE(job.as_raw_handle()),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                size,
            )
        }
        .map_err(|error| format!("failed to configure tunnel job: {error}"))?;
        command.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
        let child = command.spawn()
            .map_err(|error| format!("failed to start cloudflared: {error}"))?;
        let mut owned = Self { child, job };
        // SAFETY: both kernel handles are owned and live. The leader is still
        // suspended; assignment failure cannot release unowned executable code.
        let assigned = unsafe {
            AssignProcessToJobObject(
                HANDLE(owned.job.as_raw_handle()), HANDLE(owned.child.as_raw_handle()),
            )
        }
        .map_err(|error| format!("failed to assign tunnel job: {error}"));
        if let Err(error) = assigned.and_then(|()| owned.resume()) {
            // Incompatible enclosing jobs fail closed. Kill using Child's handle,
            // not a PID, while the leader is suspended and cannot spawn anything.
            if let Err(cleanup) = owned.child.kill() {
                eprintln!("failed to kill suspended cloudflared: {cleanup}");
            } else if let Err(cleanup) = owned.wait_bounded(super::STOP_TIMEOUT) {
                eprintln!("failed to reap suspended cloudflared: {cleanup}");
            }
            return Err(error);
        }
        Ok(owned)
    }

    fn resume(&mut self) -> Result<(), String> {
        // std::process retains the process handle, not the primary thread handle.
        // This suspended, live leader cannot recycle its PID or spawn threads.
        // SAFETY: snapshot handle is checked by windows and owned exactly once.
        let snapshot = unsafe {
            let handle = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
                .map_err(|error| format!("failed to snapshot tunnel thread: {error}"))?;
            OwnedHandle::from_raw_handle(handle.0)
        };
        let mut entry = THREADENTRY32 {
            dwSize: u32::try_from(std::mem::size_of::<THREADENTRY32>())
                .map_err(|error| error.to_string())?,
            ..Default::default()
        };
        // SAFETY: initialized, correctly sized writable entry; live snapshot.
        unsafe { Thread32First(HANDLE(snapshot.as_raw_handle()), &mut entry) }
            .map_err(|error| format!("failed to find tunnel thread: {error}"))?;
        loop {
            if entry.th32OwnerProcessID == self.child.id() {
                // SAFETY: thread belongs to the suspended owned leader; checked
                // handle has one owner and remains live throughout resume.
                let thread = unsafe {
                    let handle = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                        .map_err(|error| format!("failed to open tunnel thread: {error}"))?;
                    OwnedHandle::from_raw_handle(handle.0)
                };
                // SAFETY: live thread handle with THREAD_SUSPEND_RESUME access.
                if unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) } == u32::MAX {
                    return Err(format!("failed to resume tunnel thread: {}", std::io::Error::last_os_error()));
                }
                return Ok(());
            }
            // SAFETY: same live snapshot and initialized writable entry.
            unsafe { Thread32Next(HANDLE(snapshot.as_raw_handle()), &mut entry) }
                .map_err(|error| format!("failed to find tunnel thread: {error}"))?;
        }
    }

    pub(super) fn wait_bounded(&mut self, timeout: Duration) -> Result<ExitStatus, String> {
        let milliseconds = u32::try_from(timeout.as_millis())
            .map_err(|error| format!("invalid tunnel wait timeout: {error}"))?;
        if milliseconds == u32::MAX {
            return Err("tunnel wait timeout must be finite".to_string());
        }
        // SAFETY: Child owns this process handle with SYNCHRONIZE access. The
        // mutable borrow keeps it and the job alive throughout this finite wait.
        // A process stays signaled after exit, so no exit notification is lost.
        match unsafe { WaitForSingleObject(HANDLE(self.child.as_raw_handle()), milliseconds) } {
            WAIT_OBJECT_0 => self.child.try_wait()
                .map_err(|error| format!("failed to reap cloudflared: {error}"))?
                .ok_or_else(|| "signaled cloudflared process has no exit status".to_string()),
            WAIT_TIMEOUT => Err("cloudflared did not exit before wait timeout".to_string()),
            WAIT_FAILED => Err(format!("failed to wait for cloudflared: {}", std::io::Error::last_os_error())),
            result => Err(format!("unexpected cloudflared wait result: {}", result.0)),
        }
    }

    pub(super) fn terminate_tree(&self) -> Result<(), String> {
        // SAFETY: job remains owned even after Child::wait reaps the leader.
        unsafe { TerminateJobObject(HANDLE(self.job.as_raw_handle()), 1) }
            .map_err(|error| format!("failed to terminate tunnel job: {error}"))
    }
}

impl Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child { &self.child }
}

impl DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child { &mut self.child }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Err(error) = self.terminate_tree() {
            eprintln!("{error}");
        }
        // OwnedHandle closes the kill-on-close job, including on startup failure.
    }
}
