# 第三方资源与授权

本项目的界面、跟随规则、乐器适配、采样播放和简化谱面渲染代码均为本次课程工程编写，没有将规则匹配宣称为已部署的模型。

## 乐器采样

- 项目：tonejs-instruments
- 作者：Nicholaus P. Brosowsky
- 来源：https://github.com/nbrosowsky/tonejs-instruments
- 采样目录：`samples/piano`、`samples/guitar-nylon`
- 采样授权：CC BY 3.0，https://creativecommons.org/licenses/by/3.0/
- 原项目代码授权：MIT；原始声明保存在 `samples/LICENSE.md`。
- 本项目只收录少量 MP3，按其真实 MIDI 基准音重命名，通过 Web Audio 播放速率生成相邻音高。钢琴采样为 C3、C4、E4、G4、C5；吉他为 E3、G3、C♯4、E4、C♯5。未重新录制或去除授权声明。

## 曲谱与图形

- 《小星星》：传统旋律；《欢乐颂》：贝多芬原旋律；所用短篇编配由本项目自行录入，不使用第三方现代编配或录音。
- 音阶、和弦练习及 `示例曲谱.musicxml` 为项目自行编写。
- UI 图标、装饰与谱面为代码生成 SVG/CSS，无外部图片、字体或图标依赖。

采样下载脚本仅用于重新准备资源。日常运行所有资源均从本地读取，无 CDN 依赖。
