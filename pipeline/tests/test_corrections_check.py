import json

from conftest import seg, tx

from wts.corrections import CorrectionRule
from wts.corrections_check import Change, changes_digest, rule_changes

GLUE = CorrectionRule(("glue",), "Glew", None)


def write(dir_, stem, text):
    (dir_ / f"{stem}.json").write_text(json.dumps(tx(seg(text))))


def test_finds_a_change_in_two_transcripts(tmp_path):
    write(tmp_path, "b", "I love glue.")
    write(tmp_path, "a", "Glue is great.")
    write(tmp_path, "c", "Nothing here.")
    changes = rule_changes(tmp_path, [], [GLUE])
    assert [(c.stem, c.before, c.after) for c in changes] == [
        ("a", "Glue is great.", "Glew is great."),
        ("b", "I love glue.", "I love Glew."),
    ]
    assert all(isinstance(c, Change) and c.start_ms == 0 for c in changes)


def test_no_change_for_a_rule_that_matches_nothing(tmp_path):
    write(tmp_path, "a", "Glue is great.")
    assert rule_changes(tmp_path, [], [CorrectionRule(("nails",), "Nayls", None)]) == []


def test_an_episode_rule_only_changes_its_episode(tmp_path):
    write(tmp_path, "a", "Glue it.")
    write(tmp_path, "b", "Glue it.")
    rule = CorrectionRule(("glue",), "Glew", "b")
    assert [c.stem for c in rule_changes(tmp_path, [], [rule])] == ["b"]


def test_digest_differs_when_a_change_does():
    a = Change("s", 0, "x", "y")
    assert changes_digest([a]) == changes_digest([Change("s", 0, "x", "y")])
    assert changes_digest([a]) != changes_digest([Change("s", 0, "x", "z")])
    assert changes_digest([a]) != changes_digest([Change("s", 1, "x", "y")])
    assert changes_digest([a]) != changes_digest([])
    assert len(changes_digest([])) == 64
