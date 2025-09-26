#!/bin/bash

list_targets() {
    osascript <<'AS'
set targets to {}
set claudeAdded to false
set codexAdded to false

tell application "System Events"
    if exists (processes where name is "Obsidian") then
        set end of targets to "obsidian|Obsidian"
    end if
end tell

tell application "Terminal"
    set windowCount to count of windows
    if windowCount > 0 then
        repeat with win in windows
            repeat with t in tabs of win
                try
                    set procNames to processes of t
                    if (procNames contains "claude") and claudeAdded is false then
                        set end of targets to "terminal_claude|Terminal claude"
                        set claudeAdded to true
                    end if
                    if (procNames contains "codex") and codexAdded is false then
                        set end of targets to "terminal_codex|Terminal codex"
                        set codexAdded to true
                    end if
                end try
            end repeat
        end repeat
        set end of targets to "terminal_frontmost|Terminal frontmost"
    end if
end tell

set text item delimiters to "\n"
return targets as text
AS
}

if [[ "$1" == "--list-targets" ]]; then
    list_targets
    exit 0
fi

TARGET=""
if [[ "$1" == "--target" ]]; then
    TARGET="$2"
    if [[ -z "$TARGET" ]]; then
        echo "Error: --target には値が必要です" >&2
        exit 1
    fi
    shift 2
fi

# 送信するテキスト（引数から取得、デフォルトは「こんにちは」）
TEXT="${1:-こんにちは}"

# 末尾の句読点やピリオドを削除
TEXT_CLEAN="${TEXT%。}"
TEXT_CLEAN="${TEXT_CLEAN%、}"
TEXT_CLEAN="${TEXT_CLEAN%.}"

send_to_obsidian() {
    osascript <<'AS'
tell application "System Events"
    if exists (processes where name is "Obsidian") then
        tell process "Obsidian"
            set frontmost to true
            keystroke "v" using command down
        end tell
        return "Obsidianに送信しました"
    else
        return "Obsidianが見つかりませんでした"
    end if
end tell
AS
}

send_to_claude() {
    osascript <<'AS'
tell application "Terminal"
    repeat with win in windows
        repeat with t in tabs of win
            set processName to processes of t
            if processName contains "claude" then
                set frontmost of win to true
                set selected of t to true
                tell application "System Events"
                    keystroke "v" using command down
                end tell
                return "claude ウィンドウに送信しました"
            end if
        end repeat
    end repeat
    return "claudeウィンドウが見つかりませんでした"
end tell
AS
}

send_to_codex() {
    osascript <<'AS'
tell application "Terminal"
    repeat with win in windows
        repeat with t in tabs of win
            set processName to processes of t
            if processName contains "codex" then
                set frontmost of win to true
                set selected of t to true
                tell application "System Events"
                    keystroke "v" using command down
                end tell
                return "codex ウィンドウに送信しました"
            end if
        end repeat
    end repeat
    return "codexウィンドウが見つかりませんでした"
end tell
AS
}

send_to_frontmost_terminal() {
    osascript <<'AS'
tell application "Terminal"
    if (count of windows) > 0 then
        activate
        tell application "System Events"
            keystroke "v" using command down
        end tell
        return "最前面のターミナルに送信しました"
    else
        return "ターミナルウィンドウが開いていません"
    end if
end tell
AS
}

send_special_enter() {
    if [[ -n "$TARGET" ]]; then
        case "$TARGET" in
            obsidian)
                send_to_obsidian
                ;;
            terminal_claude)
                send_to_claude
                ;;
            terminal_codex)
                send_to_codex
                ;;
            terminal_frontmost)
                send_to_frontmost_terminal
                ;;
            *)
                echo "Unknown target: $TARGET" >&2
                return 1
                ;;
        esac
        return 0
    fi

    osascript <<'AS'
-- まずObsidianをチェック
tell application "System Events"
    if exists (processes where name is "Obsidian") then
        tell process "Obsidian"
            set frontmost to true
            key code 36 -- Return key
        end tell
        return "EnterキーをObsidianに送信しました"
    end if
end tell

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
AS
}

send_special_cancel() {
    if [[ -n "$TARGET" ]]; then
        case "$TARGET" in
            obsidian)
                osascript <<'AS'
tell application "System Events"
    if exists (processes where name is "Obsidian") then
        tell process "Obsidian"
            set frontmost to true
            keystroke "c" using control down
        end tell
        return "Ctrl+CをObsidianに送信しました"
    else
        return "Obsidianが見つかりませんでした"
    end if
end tell
AS
                ;;
            terminal_claude)
                osascript <<'AS'
tell application "Terminal"
    repeat with win in windows
        repeat with t in tabs of win
            set processName to processes of t
            if processName contains "claude" then
                set frontmost of win to true
                set selected of t to true
                tell application "System Events"
                    keystroke "c" using control down
                end tell
                return "Ctrl+Cを送信しました"
            end if
        end repeat
    end repeat
    return "claudeウィンドウが見つかりませんでした"
end tell
AS
                ;;
            terminal_codex)
                osascript <<'AS'
tell application "Terminal"
    repeat with win in windows
        repeat with t in tabs of win
            set processName to processes of t
            if processName contains "codex" then
                set frontmost of win to true
                set selected of t to true
                tell application "System Events"
                    keystroke "c" using control down
                end tell
                return "Ctrl+Cを送信しました"
            end if
        end repeat
    end repeat
    return "codexウィンドウが見つかりませんでした"
end tell
AS
                ;;
            terminal_frontmost)
                osascript <<'AS'
tell application "Terminal"
    if (count of windows) > 0 then
        activate
        tell application "System Events"
            keystroke "c" using control down
        end tell
        return "最前面のターミナルにCtrl+Cを送信しました"
    else
        return "ターミナルウィンドウが開いていません"
    end if
end tell
AS
                ;;
            *)
                echo "Unknown target: $TARGET" >&2
                return 1
                ;;
        esac
        return 0
    fi

    osascript <<'AS'
-- まずObsidianをチェック
tell application "System Events"
    if exists (processes where name is "Obsidian") then
        tell process "Obsidian"
            set frontmost to true
            keystroke "c" using control down
        end tell
        return "Ctrl+CをObsidianに送信しました"
    end if
end tell

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
AS
}

# 特殊コマンドのチェック（--target指定時はテキストのまま扱いたいケースもあるので特別処理）
if [[ -z "$TARGET" ]]; then
    if [[ "$TEXT_CLEAN" == "実行" ]] || [[ "$TEXT_CLEAN" == "Enter" ]] || [[ "$TEXT_CLEAN" == "enter" ]]; then
        send_special_enter
        echo "送信完了: Enterキー"
        exit 0
    fi

    if [[ "$TEXT_CLEAN" == "やめます" ]] || [[ "$TEXT_CLEAN" == "キャンセルします" ]] || [[ "$TEXT_CLEAN" == "キャンセルします。" ]] || [[ "$TEXT_CLEAN" == "クリアします。" ]] || [[ "$TEXT_CLEAN" == "cancel" ]] || [[ "$TEXT_CLEAN" == "Cancel" ]]; then
        send_special_cancel
        echo "送信完了: Ctrl+C"
        exit 0
    fi
fi

# 通常のテキストの場合はクリップボード経由で送信
echo -n "$TEXT" | pbcopy

if [[ -n "$TARGET" ]]; then
    case "$TARGET" in
        obsidian)
            result=$(send_to_obsidian)
            ;;
        terminal_claude)
            result=$(send_to_claude)
            ;;
        terminal_codex)
            result=$(send_to_codex)
            ;;
        terminal_frontmost)
            result=$(send_to_frontmost_terminal)
            ;;
        *)
            echo "Unknown target: $TARGET" >&2
            exit 1
            ;;
    esac
    echo "$result"
    if [[ "$result" == *"送信しました"* ]]; then
        exit 0
    else
        exit 1
    fi
fi

# 優先順位: Obsidian > Claude > Codex > 最前面のターミナル
obsidian_result=$(send_to_obsidian)
claude_result=$(send_to_claude)
codex_result=$(send_to_codex)

echo "Obsidian: $obsidian_result"
echo "Claude: $claude_result"
echo "Codex: $codex_result"

if [[ "$obsidian_result" != *"見つかりませんでした"* ]]; then
    echo "送信完了: $TEXT"
    exit 0
fi

if [[ "$claude_result" != *"見つかりませんでした"* ]]; then
    echo "送信完了: $TEXT"
    exit 0
fi

if [[ "$codex_result" != *"見つかりませんでした"* ]]; then
    echo "送信完了: $TEXT"
    exit 0
fi

fallback_result=$(send_to_frontmost_terminal)
echo "フォールバック: $fallback_result"
echo "送信完了: $TEXT"
