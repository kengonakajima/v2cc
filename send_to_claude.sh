#!/bin/bash

# 送信するテキスト（引数から取得、デフォルトは「こんにちは」）
TEXT="${1:-こんにちは}"

# 末尾の句読点を削除
TEXT_CLEAN="${TEXT%。}"
TEXT_CLEAN="${TEXT_CLEAN%、}"

# 特殊コマンドのチェック
if [[ "$TEXT_CLEAN" == "実行" ]]; then
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

if [[ "$TEXT_CLEAN" == "やめます" ]] || [[ "$TEXT_CLEAN" == "キャンセルします。" ]] || [[ "$TEXT_CLEAN" == "クリアします。" ]]; then
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

# AppleScriptでTerminalアプリのclaudeコマンドを実行しているウィンドウを探して送信
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
    
    -- claudeが見つからない場合は最前面のターミナルに送信
    if (count of windows) > 0 then
        tell application "System Events"
            keystroke "v" using command down
        end tell
        return "claudeウィンドウが見つからないため、最前面のターミナルに送信しました"
    else
        return "ターミナルウィンドウが開いていません"
    end if
end tell
EOF

echo "送信完了: $TEXT"
