on open location theURL
	do shell script "echo $(date): " & quoted form of theURL & " >> /tmp/tlda-url-handler.log"

	set action to do shell script "echo " & quoted form of theURL & " | sed 's|^tlda://||' | sed 's|[?/].*||' | tr -d '[:space:]'"

	if action is "voice-reset" then
		-- Save all open tab URLs via CDP (only talks to our Chrome on port 9222)
		set tabURLs to {}
		try
			set tabJson to do shell script "curl -s http://localhost:9222/json/list 2>/dev/null"
			set tabURLs to paragraphs of (do shell script "echo " & quoted form of tabJson & " | python3 -c \"import sys,json; [print(t['url']) for t in json.loads(sys.stdin.read()) if t.get('type')=='page']\" 2>/dev/null")
		end try

		-- Kill any rogue playwright
		try
			do shell script "pkill -9 -f playwright_chromiumdev_profile 2>/dev/null; true"
		end try

		-- Kill ONLY our Chrome (the one with .chrome-debug user-data-dir)
		-- This leaves playwright Chrome processes alone
		try
			do shell script "pkill -f 'user-data-dir.*/\\.chrome-debug' 2>/dev/null; true"
		end try

		-- Wait for our Chrome to exit
		repeat
			try
				do shell script "pgrep -f 'user-data-dir.*/\\.chrome-debug' > /dev/null 2>&1"
				delay 0.5
			on error
				exit repeat
			end try
		end repeat

		delay 1

		-- Reopen Chrome directly with debug flags (bypass wrapper which kills all Chrome)
		do shell script "open -a 'Google Chrome' --args --remote-debugging-port=9222 --user-data-dir=$HOME/.chrome-debug --remote-allow-origins='*'"

		-- Wait for Chrome to be ready
		delay 3

		-- Navigate to saved tabs
		if (count of tabURLs) > 0 then
			tell application "Google Chrome"
				-- Set first tab to our URL
				set URL of active tab of window 1 to item 1 of tabURLs
				-- Open remaining tabs
				if (count of tabURLs) > 1 then
					repeat with i from 2 to count of tabURLs
						tell window 1
							make new tab with properties {URL:item i of tabURLs}
						end tell
					end repeat
				end if
				set active tab index of window 1 to 1
			end tell
		end if

		display notification "Chrome restarted" with title "tlda voice reset"
	else
		display notification "Unknown action: [" & action & "]" with title "tlda"
	end if
end open location
