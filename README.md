# v2cc : Voice to Claude Code

声でClaudeCodeに指示を送るツールです。
読み上げはしません。

OpenAIのリアルタイムAPIで音声認識し、最も手前のターミナルウインドウ
で動いているClaude Codeに対して認識結果を送ります。


問題: OpenAIのクレジットが切れてるときにエラーを表示できない場合があります。


## セットアップ

```bash
brew install sox
npm install
echo "OPENAI_API_KEY=sk-xxx" > .env
```

## 実行する

```bash
node v2cc.js
```

## 特殊コマンド
一呼吸置いてから、特殊な命令をすることで、EnterキーとCtrl-Cを送れます。
Ctrl-Cを送ると、入力中のテキストを全部消せます。


- 実行 → Enter
- やめます/キャンセルします → Ctrl+C

## テストした環境

- macOS 10.15+
- Node.js 18+
- OpenAI API key