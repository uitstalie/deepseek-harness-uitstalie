# task2 — Cordis 核心五要素详细架构（变更自 task1）

## requirement

变更自：[task1](task1.md)。task1 的架构梳理被认为过于笼统，只有核心概念层。本任务聚焦 Cordis 最核心的五要素——Context、Plugin、Fiber、Effect、Service——给出**详细**的描述与架构（类结构、关键字段、方法签名、状态机、交互时序、源码锚点），目标是支撑后续大规模替换插件的工作。

## 修改范围

- 纯研究与文档任务：不修改任何原生文件。
- 新增分支自有文件：
  - 本任务单 `goal/mission/task2.md`
  - 重写 `goal/cordis-architecture.md`（聚焦核心五要素的详细版）

## 原生文件修改登记

无（本任务不涉及原生文件修改或删除）。
