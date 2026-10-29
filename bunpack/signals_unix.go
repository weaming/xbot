//go:build !windows

package main

import (
	"os"
	"syscall"
)

// handledSignals 是需要由包装器接住并转发给子进程的终止信号。
func handledSignals() []os.Signal {
	return []os.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP}
}
