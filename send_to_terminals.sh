#!/bin/bash

# 送信するテキスト（引数から取得、デフォルトは「こんにちは」）
TEXT="${1:-こんにちは}"

# 末尾の句読点やピリオドを削除
TEXT_CLEAN="${TEXT%。}"
TEXT_CLEAN="${TEXT_CLEAN%、}"
TEXT_CLEAN="${TEXT_CLEAN%.}"

# 特殊コマンドのチェック
# Enterキー送信コマンド（日本語・英語両対応）
if [[ "$TEXT_CLEAN" == "実行" ]] || [[ "$TEXT_CLEAN" == "Enter" ]] || [[ "$TEXT_CLEAN" == "enter" ]]; then
    # Enterキーを直接送信
    osascript <<'EOF'
tell application "Terminal"
    -- claudeコマンドを実行しているウィンドウを探す
    repeat with win in windows
        repeat with t in tabs of win
            set processName to processes of t
            if processName contains "claude" then
                set frontmost of win to true
                set selected of t to true
                -- Returnキーを送信
                tell application "System Events"
                    key code 36 -- Return key
                end tell
                return "Enterキーを送信しました"
            end if
        end repeat
    end repeat
    
    -- claudeが見つからない場合は最前面のターミナルに送信
    if (count of windows) > 0 then
        tell application "System Events"
            key code 36 -- Return key
        end tell
        return "Enterキーを最前面のターミナルに送信しました"
    end if
end tell
EOF
    echo "送信完了: Enterキー"
    exit 0
fi

# キャンセルコマンド（日本語・英語両対応）
if [[ "$TEXT_CLEAN" == "やめます" ]] || [[ "$TEXT_CLEAN" == "キャンセルします" ]] || [[ "$TEXT_CLEAN" == "cancel" ]] || [[ "$TEXT_CLEAN" == "Cancel" ]]; then
    # Ctrl+Cを送信
    osascript <<'EOF'
tell application "Terminal"
    -- claudeコマンドを実行しているウィンドウを探す
    repeat with win in windows
        repeat with t in tabs of win
            set processName to processes of t
            if processName contains "claude" then
                set frontmost of win to true
                set selected of t to true
                -- Ctrl+Cを送信
                tell application "System Events"
                    keystroke "c" using control down
                end tell
                return "Ctrl+Cを送信しました"
            end if
        end repeat
    end repeat
    
    -- claudeが見つからない場合は最前面のターミナルに送信
    if (count of windows) > 0 then
        tell application "System Events"
            keystroke "c" using control down
        end tell
        return "最前面のターミナルにCtrl+Cを送信しました"
    end if
end tell
EOF
    echo "送信完了: Ctrl+C"
    exit 0
fi

# 通常のテキストの場合はクリップボード経由で送信
echo -n "$TEXT" | pbcopy

# Claude用の送信関数
send_to_claude() {
    osascript <<'EOF'
tell application "Terminal"
    -- すべてのウィンドウをチェック
    repeat with win in windows
        -- ウィンドウ内のタブをチェック
        repeat with t in tabs of win
            -- プロセス名を取得
            set processName to processes of t
            -- claudeコマンドが実行されているか確認
            if processName contains "claude" then
                -- そのウィンドウを最前面に
                set frontmost of win to true
                -- アクティブなタブに設定
                set selected of t to true
                -- Cmd+Vを送信
                tell application "System Events"
                    keystroke "v" using command down
                end tell
                return "claude ウィンドウに送信しました"
            end if
        end repeat
    end repeat
    return "claudeウィンドウが見つかりませんでした"
end tell
EOF
}

# Codex用の送信関数
send_to_codex() {
    osascript <<'EOF'
tell application "Terminal"
    -- すべてのウィンドウをチェック
    repeat with win in windows
        -- ウィンドウ内のタブをチェック
        repeat with t in tabs of win
            -- プロセス名を取得
            set processName to processes of t
            -- codexコマンドが実行されているか確認
            if processName contains "codex" then
                -- そのウィンドウを最前面に
                set frontmost of win to true
                -- アクティブなタブに設定
                set selected of t to true
                -- Cmd+Vを送信
                tell application "System Events"
                    keystroke "v" using command down
                end tell
                return "codex ウィンドウに送信しました"
            end if
        end repeat
    end repeat
    return "codexウィンドウが見つかりませんでした"
end tell
EOF
}

# 両方に送信
claude_result=$(send_to_claude)
codex_result=$(send_to_codex)

echo "Claude: $claude_result"
echo "Codex: $codex_result"

# どちらも見つからない場合は最前面のターミナルに送信
if [[ "$claude_result" == *"見つかりませんでした"* ]] && [[ "$codex_result" == *"見つかりませんでした"* ]]; then
    osascript <<'EOF'
tell application "Terminal"
    if (count of windows) > 0 then
        tell application "System Events"
            keystroke "v" using command down
        end tell
        return "最前面のターミナルに送信しました"
    else
        return "ターミナルウィンドウが開いていません"
    end if
end tell
EOF
    echo "フォールバック: 最前面のターミナルに送信"
fi

echo "送信完了: $TEXT"