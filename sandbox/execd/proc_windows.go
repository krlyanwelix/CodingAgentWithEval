//go:build windows

package main

import (
	"os"
	"os/exec"
	"strconv"
)

func shellCommand(command string) (string, []string) {
	comspec := os.Getenv("COMSPEC")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	return comspec, []string{"/d", "/s", "/c", command}
}

func configureCommand(cmd *exec.Cmd) {}

func killCommand(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
}
