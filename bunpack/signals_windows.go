//go:build windows

package main

import "os"

// handledSignals Windows 只有 Ctrl-C 一种可移植的终止信号。
func handledSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
