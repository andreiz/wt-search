from collections import Counter

import pytest

from wts import corrections_edit
from wts.corrections import CORRECTIONS_FILE, CorrectionRule, rules_from_text
from wts.corrections_edit import EditFailed, RuleExists, add_rule

BASE = """\
# header comment
global:
  saw stop: SawStop  # inline
  # about festool
  fest tool: Festool

# introduces keep
keep:
  - Craig Jackson
episodes:
  ep1:
    craig er: Kregger
  # about ep2
  ep2:
    foo: Bar

  ep3:
    baz: Qux
"""


def inserted(old: str, new: str) -> list[str]:
    """The lines of `new` that are not in `old`, checking `old` survives in order."""
    old_lines, new_lines = old.splitlines(keepends=True), new.splitlines(keepends=True)
    out, i = [], 0
    for line in new_lines:
        if i < len(old_lines) and line == old_lines[i]:
            i += 1
        else:
            out.append(line)
    assert i == len(old_lines), "an untouched line changed"
    return out


def check_reload(old: str, new: str, rule: CorrectionRule) -> None:
    assert Counter(rules_from_text(new)) == Counter(rules_from_text(old) + [rule])


def test_global_rule_lands_at_end_of_block():
    new = add_rule(BASE, "wood glue", "Wood Glew", None)
    assert inserted(BASE, new) == ["  wood glue: Wood Glew\n"]
    lines = new.splitlines()
    i = lines.index("  wood glue: Wood Glew")
    assert lines[i - 1] == "  fest tool: Festool"
    assert lines[i + 1:i + 3] == ["", "# introduces keep"]
    check_reload(BASE, new, CorrectionRule(("wood", "glue"), "Wood Glew", None))


def test_episode_rule_with_existing_stem():
    new = add_rule(BASE, "Hello there", "Hi", "ep1")
    assert inserted(BASE, new) == ["    Hello there: Hi\n"]
    assert new.index("Hello there") < new.index("# about ep2")
    check_reload(BASE, new, CorrectionRule(("hello", "there"), "Hi", "ep1"))


def test_episode_rule_skips_trailing_blank_in_stem_block():
    new = add_rule(BASE, "new", "New", "ep2")
    assert inserted(BASE, new) == ["    new: New\n"]
    lines = new.splitlines()
    assert lines[lines.index("    new: New") - 1] == "    foo: Bar"
    check_reload(BASE, new, CorrectionRule(("new",), "New", "ep2"))


def test_episode_rule_for_last_stem():
    new = add_rule(BASE, "new", "New", "ep3")
    assert new == BASE + "    new: New\n"


def test_episode_rule_with_new_stem_goes_at_end_of_episodes():
    new = add_rule(BASE, "new", "New", "2026-08-19_ep613_x")
    assert inserted(BASE, new) == ["  2026-08-19_ep613_x:\n", "    new: New\n"]
    assert new.startswith(BASE)
    check_reload(BASE, new, CorrectionRule(("new",), "New", "2026-08-19_ep613_x"))


def test_episode_rule_without_episodes_block():
    old = "global:\n  a: B\n"
    new = add_rule(old, "new", "New", "ep1")
    assert new == old + "\nepisodes:\n  ep1:\n    new: New\n"
    check_reload(old, new, CorrectionRule(("new",), "New", "ep1"))


def test_episodes_block_added_after_text_without_final_newline():
    old = "global:\n  a: B"
    new = add_rule(old, "new", "New", "ep1")
    assert new == "global:\n  a: B\n\nepisodes:\n  ep1:\n    new: New\n"


def test_empty_file_and_missing_global():
    new = add_rule("", "a", "B", None)
    assert new == "global:\n  a: B\n"
    old = "episodes:\n  ep1:\n    x: Y\n"
    new = add_rule(old, "a", "B", None)
    assert new == old + "\nglobal:\n  a: B\n"
    check_reload(old, new, CorrectionRule(("a",), "B", None))


def test_file_without_final_newline():
    old = "global:\n  a: B"
    new = add_rule(old, "c", "D", None)
    assert new == "global:\n  a: B\n  c: D\n"
    check_reload(old, new, CorrectionRule(("c",), "D", None))


def test_crlf_is_kept():
    old = BASE.replace("\n", "\r\n")
    new = add_rule(old, "wood glue", "Wood Glew", None)
    assert inserted(old, new) == ["  wood glue: Wood Glew\r\n"]
    assert "\n" not in new.replace("\r\n", "")
    new = add_rule(old, "z", "Z", "brand-new")
    assert inserted(old, new) == ["  brand-new:\r\n", "    z: Z\r\n"]


@pytest.mark.parametrize(
    ("key", "line"),
    [
        ("a: b", '  "a: b": V\n'),
        ('say "hi"', '  "say \\"hi\\"": V\n'),
        ("- dash", '  "- dash": V\n'),
        ("#hash", '  "#hash": V\n'),
        ("café", '  "café": V\n'),
        (" padded", '  " padded": V\n'),
        ("rubo's", "  rubo's: V\n"),
        ("t9.5-x", "  t9.5-x: V\n"),
    ],
)
def test_awkward_keys(key, line):
    from wts.corrections import _match_words

    old = "global:\n  a: B\n"
    new = add_rule(old, key, "V", None)
    assert inserted(old, new) == [line]
    check_reload(old, new, CorrectionRule(_match_words(key), "V", None))


def test_value_no_stays_text():
    old = "global:\n  a: B\n"
    new = add_rule(old, "nope", "no", None)
    assert inserted(old, new) == ["  nope: no\n"]
    check_reload(old, new, CorrectionRule(("nope",), "no", None))


def test_numeric_value_stays_text():
    old = "global:\n  a: B\n"
    new = add_rule(old, "n", "123", None)
    assert inserted(old, new) == ["  n: 123\n"]
    assert CorrectionRule(("n",), "123", None) in rules_from_text(new)


def test_value_with_slash_or_colon_is_quoted():
    old = "global:\n  a: B\n"
    assert inserted(old, add_rule(old, "n", "4/4", None)) == ['  n: "4/4"\n']
    assert inserted(old, add_rule(old, "n", "a: b", None)) == ['  n: "a: b"\n']
    assert inserted(old, add_rule(old, "n", "a # b", None)) == ['  n: "a # b"\n']


def test_empty_value_is_a_deletion():
    old = "global:\n  a: B\n"
    new = add_rule(old, "uh", "", None)
    assert inserted(old, new) == ['  uh: ""\n']
    check_reload(old, new, CorrectionRule(("uh",), "", None))


def test_duplicate_raises():
    with pytest.raises(RuleExists):
        add_rule(BASE, "Saw, Stop!", "Other", None)
    with pytest.raises(RuleExists):
        add_rule(BASE, "craig er", "X", "ep1")
    with pytest.raises(RuleExists):
        add_rule(BASE, "FOO", "X", "ep2")


def test_same_key_in_another_scope_is_not_a_duplicate():
    new = add_rule(BASE, "saw stop", "X", "ep1")
    check_reload(BASE, new, CorrectionRule(("saw", "stop"), "X", "ep1"))
    new = add_rule(BASE, "foo", "X", None)
    check_reload(BASE, new, CorrectionRule(("foo",), "X", None))


@pytest.mark.parametrize("key", ["", "   ", "...", "-- !!"])
def test_key_without_match_words_is_a_value_error(key):
    with pytest.raises(ValueError):
        add_rule(BASE, key, "X", None)


def test_edit_that_does_not_reload_as_old_plus_one_fails(monkeypatch):
    monkeypatch.setattr(corrections_edit, "_scalar", lambda s: "[unbalanced")
    with pytest.raises(EditFailed):
        add_rule(BASE, "new", "New", None)


def test_a_duplicate_stem_header_spelled_differently_fails():
    old = 'episodes:\n  "ep1":\n    a: B\n'
    with pytest.raises(EditFailed):
        add_rule(old, "c", "D", "ep1")


@pytest.mark.parametrize("episode", [None, "2026-08-19_ep613_shove-a-kregger-in-the-hole", "new"])
def test_real_corrections_file(episode):
    old = CORRECTIONS_FILE.read_text()
    new = add_rule(old, "zzz test key", "Zzz Value", episode)
    assert len(inserted(old, new)) in (1, 2)
    check_reload(old, new, CorrectionRule(("zzz", "test", "key"), "Zzz Value", episode))
