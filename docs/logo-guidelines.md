# Trace RCA Logo 使用说明

## 设计含义

Logo 由三条带节点的 Trace 路径和一个根因定位点构成：

- 三条路径表示 Agent 运行中的模型推理、Tool 调用、Skill 执行和中间事实链；
- 路径逐步收敛表示从大量 Trace 信息中缩小调查范围；
- 末端圆环和中心点表示经证据校验后定位到的 Root Cause；
- 圆角方形与现有 Web 界面的克制、简洁风格保持一致。

## 资产

| 文件 | 用途 |
| --- | --- |
| `src/web/public/assets/logo-mark.svg` | 浅色页面、导航栏和常规图标 |
| `src/web/public/assets/logo-mark-dark.svg` | 深色页面或演示文稿 |
| `src/web/public/assets/logo-horizontal.svg` | 浅色文档封面、README、宽版品牌区 |
| `src/web/public/assets/logo-horizontal-dark.svg` | 深色演示文稿、深色品牌区 |
| `src/web/public/assets/logo-mark-mono.svg` | 单色印刷、刻印和受限色彩场景 |
| `src/web/public/assets/favicon.svg` | 浏览器标签页 |

## 色彩

- Trace 蓝：`#0071E3`
- 高亮蓝：`#2997FF`
- 深蓝：`#0062C8`
- 石墨黑：`#1D1D1F`
- 暖白：`#F5F5F7`

## 使用规则

1. 图标最小显示尺寸为 `24 × 24 px`；低于该尺寸时优先使用 `favicon.svg`。
2. Logo 四周至少保留图标宽度 `1/4` 的安全留白。
3. 不拉伸、不旋转、不改变路径与根因点的相对位置。
4. 浅色界面使用标准版；深色界面使用深色版。
5. Logo 旁已有可见产品名时，图标作为装饰使用空 `alt`；独立出现时应提供 `Trace RCA` 文本替代。

## 核心识别语义

- **Trace**：左侧三条带节点的运行轨迹；
- **RCA**：路径不是简单汇聚，而是在靶点外圈完成证据校验与定位；
- **Agent**：多分支输入代表模型推理、工具调用、Skill 与中间事实链；
- **可信度**：克制的几何语言强调“证据先于结论”，避免使用放大镜、机器人头等泛化图标。

预览板：`docs/trace-rca-logo-preview.html`。
