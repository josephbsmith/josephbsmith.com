from pathlib import Path


page = Path(__file__).with_name("plusfive.html").read_text()
assert "type=number" not in page and "inputmode=decimal" not in page
assert 'data-step="5"' in page and 'data-step="2.5"' in page
assert "--bg:#b9e4f1" in page and "--client:#eaf7fb" in page
assert "<h3>${esc(name)}</h3>" in page and "lift.replace('_',' ')" not in page
assert '<span class="five">Five</span>' in page and "Novice Progression Logbook" not in page
assert 'class="toolbar timerbar"' in page and '>3:00</span><button id="resetTimer" disabled>' in page
assert "starting-strength-basic-barbell-training" in page and "startingstrength.com/radio" in page
assert "no payment, profit, commission, affiliate revenue, personal data, workout data, or analytics" in page
assert "@media(prefers-color-scheme:dark)" in page and "color-scheme:dark" in page
assert 'media="(prefers-color-scheme: light)"' in page and 'media="(prefers-color-scheme: dark)"' in page
assert "--bg:#132c3d" in page and "--client:#1b3d55" in page

print("PlusFive browser check passed")
