LectureAI Core v7.5
===================

This build keeps the working Echo360 subtitle pipeline and restores the full study-tool system.

Key fixes
---------
1. Echo360 transcript-file VTT discovery fallback for lessons without a normal <track>.
2. Real-time subtitle translation: Simplified Chinese / English / Tiếng Việt.
3. Visible subtitle translation toggle and language buttons in the LectureAI menu.
4. Summary, Key Terms, Quiz and Revision Pack are real features (not Coming Soon).
5. Quiz answers are hidden until the user clicks “查看答案”.
6. Quiz is a full-screen LectureAI overlay so Echo360's underlying quiz is not visually duplicated.
7. Quiz PDF lists all questions first and puts the Answer Key + Explanations after them. It does not force a second page when the content fits.
8. Summary / Key Terms / Quiz / Revision Pack each have their own PDF export button.
9. Basic mathematical notation such as e^{iθ}, x^2, subscripts, theta, pi, fractions etc. is normalized into readable text.
10. Feature language selectors use dark custom menus so text stays visible.
11. Server is consistently on localhost:3000.

API key
-------
1. Copy .env.example to .env.
2. Put your key after OPENAI_API_KEY=.
3. Never share the .env file.

Start on Windows
-----------------
1. Double-click start-server.bat.
2. Keep the black CMD window open.
3. Check http://localhost:3000/api/status.
4. In Chrome open chrome://extensions.
5. Enable Developer mode and Load unpacked.
6. Select this folder (the folder containing manifest.json).
7. Disable older LectureAI versions so only one extension injects the UI.
8. Refresh the Echo360 lecture page.

PDF
---
PDF export opens a dedicated print window. Click “Save as PDF / 打印” if the browser does not automatically open the print dialog.

Troubleshooting
---------------
- EADDRINUSE :::3000: another node.exe is running. Run taskkill /F /IM node.exe once, then start this version only.
- localhost refused: the server window is not running. Start start-server.bat.
- Missing credentials: check .env and restart the server.
- Invalid API key: replace the key with a valid key and restart.
- No subtitles: make sure only this extension is enabled, refresh Echo360, and play the lecture for a few seconds. This version first looks for VTT/track sources and then Echo360's transcript-file API.
