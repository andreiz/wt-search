from conftest import ws

from wts.corrections import (
    CORRECTIONS_FILE,
    CorrectionRule,
    apply_corrections,
    corrections_sha,
    load_corrections,
)


def rules(g=None, e=None):
    out = []
    for k, v in (g or {}).items():
        out.append(CorrectionRule(tuple(k.split()), v, None))
    for stem, mapping in (e or {}).items():
        for k, v in mapping.items():
            out.append(CorrectionRule(tuple(k.split()), v, stem))
    return out


def test_multiword_merge_keeps_timing_and_punctuation():
    out = apply_corrections(ws("I love my saw stop, really."), rules(g={"saw stop": "SawStop"}), "s")
    assert [w.text for w in out] == ["I", "love", "my", "SawStop,", "really."]
    merged = out[3]
    assert (merged.start_ms, merged.end_ms) == (3000, 4999)


def test_merged_word_takes_lowest_probability():
    words = ws("saw stop")
    words[1] = words[1].__class__(words[1].text, words[1].start_ms, words[1].end_ms, 0.2)
    assert apply_corrections(words, rules(g={"saw stop": "SawStop"}), "s")[0].prob == 0.2


def test_episode_rule_only_for_that_episode():
    r = rules(e={"2017-03-14_ep312_x": {"marc": "Mark"}})
    assert apply_corrections(ws("marc said"), r, "2017-03-14_ep312_x")[0].text == "Mark"
    assert apply_corrections(ws("marc said"), r, "other")[0].text == "marc"


def test_episode_rule_beats_global():
    r = rules(g={"marc": "Marc"}, e={"s1": {"marc": "Mark"}})
    assert apply_corrections(ws("marc"), r, "s1")[0].text == "Mark"


def test_longest_rule_wins():
    r = rules(g={"fest": "Fest", "fest tool": "Festool"})
    assert [w.text for w in apply_corrections(ws("my fest tool"), r, "s")] == ["my", "Festool"]


def test_case_insensitive_whole_word_only():
    out = apply_corrections(ws("KREMONA kremonas"), rules(g={"kremona": "Cremona"}), "s")
    assert [w.text for w in out] == ["Cremona", "kremonas"]


def test_load_shipped_file_and_sha(tmp_path):
    loaded = load_corrections(CORRECTIONS_FILE)
    assert CorrectionRule(("saw", "stop"), "SawStop", None) in loaded
    f = tmp_path / "c.yaml"
    f.write_text("global: {Kremona: Cremona}\nepisodes: {s1: {'Marc!': Mark}}\n")
    assert set(load_corrections(f)) == {
        CorrectionRule(("kremona",), "Cremona", None),
        CorrectionRule(("marc",), "Mark", "s1"),
    }
    assert load_corrections(tmp_path / "missing.yaml") == []
    assert corrections_sha(f) != corrections_sha(CORRECTIONS_FILE)
    assert corrections_sha(tmp_path / "missing.yaml") == ""
