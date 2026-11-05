//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func shellCommand(command string) (string, []string) {
	return "/bin/sh", []string{"-c", command}
}

func configureCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killCommand(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	// Kill the whole process group so `sh -c "a | b"` children cannot outlive us.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
