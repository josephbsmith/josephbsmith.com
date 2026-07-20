from pathlib import Path


page = Path(__file__).with_name("plusfive.html").read_text()
assert "type=number" not in page and "inputmode=decimal" not in page
assert 'data-step="5"' in page and 'data-step="2.5"' in page
assert "--bg:#2b4b6c" in page and "--client:#33587e" in page
assert "<h3>${esc(name)}</h3>" in page and "lift.replace('_',' ')" not in page

print("PlusFive browser check passed")
