package main

import (
	"encoding/json"
	"errors"
)

// Manifest 描述一个打包产物：入口、运行时、哪些资源走 fd、哪些必须落盘。
type Manifest struct {
	// Name 应用名，用于提示与缓存目录。
	Name string `json:"name"`
	// Entry payload 内的 JS 入口文件名。
	Entry string `json:"entry"`
	// EntryFD 入口 JS 交给子进程的文件描述符，默认 3。
	EntryFD int `json:"entryFd,omitempty"`
	// Inline 通过 fd 直接注入内存的资源，按扩展名匹配。
	Inline []string `json:"inline,omitempty"`
	// InlineFD inline 资源起始 fd，依次递增，默认从 EntryFD+1 开始。
	InlineFD int `json:"inlineFd,omitempty"`
	// InlineEnv 每个 inline 资源对应的环境变量名，指示 JS 去哪个 fd 读取。
	InlineEnv map[string]string `json:"inlineEnv,omitempty"`
	// Native 必须落盘的资源扩展名（如 ".node"）：napi 的 dlopen 只认真实路径。
	Native []string `json:"native,omitempty"`
	// NativeEnv 落盘目录对应的环境变量名。
	NativeEnv string `json:"nativeEnv,omitempty"`
	// Runtime 需要的运行时命令，默认 "bun"。
	Runtime string `json:"runtime,omitempty"`
	// RuntimeEnv 额外传给运行时的环境变量。
	// 没有对应的命令行参数，仅用于手工编写的清单。
	RuntimeEnv map[string]string `json:"runtimeEnv,omitempty"`
}

// defaults 补齐缺省值，避免清单里重复写常见约定。
func (m *Manifest) defaults() {
	if m.EntryFD == 0 {
		m.EntryFD = 3
	}
	if m.InlineFD == 0 {
		m.InlineFD = m.EntryFD + 1
	}
	if m.Runtime == "" {
		m.Runtime = "bun"
	}
	if m.Name == "" {
		m.Name = "app"
	}
}

func readManifest(entries map[string][]byte) (*Manifest, error) {
	raw, ok := entries[manifestName]
	if !ok {
		return nil, errors.New("缺少 " + manifestName)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	m.defaults()
	return &m, nil
}
