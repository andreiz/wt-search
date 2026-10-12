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


def test_lower_case_replacement_keeps_the_capital_that_starts_a_sentence():
    fix = rules(g={"mortis": "mortise", "bore foot": "board foot", "tight bond": "Titebond"})

    def text(said):
        return " ".join(w.text for w in apply_corrections(ws(said), fix, "s"))

    assert text("Mortis and tenon. This mortis is loose.") == "Mortise and tenon. This mortise is loose."
    assert text("Done! Bore foot prices? mortis.") == "Done! Board foot prices? mortise."
    # A capital in the middle of a sentence is Whisper's, not the sentence's: the rule's case wins.
    assert text("Cut the Mortis first.") == "Cut the mortise first."
    # An abbreviation's full stop does not end a sentence.
    assert text("Ask Mr. Mortis.") == "Ask Mr. mortise."
    # A replacement written with a capital is used as written, wherever it lands.
    assert text("tight bond. Tight bond and TIGHT BOND.") == "Titebond. Titebond and Titebond."


def test_replacement_with_space_becomes_separate_timed_words():
    out = apply_corrections(ws("welcome to woodtalk."), rules(g={"woodtalk": "Wood Talk"}), "s")
    assert [w.text for w in out] == ["welcome", "to", "Wood", "Talk."]
    assert (out[2].start_ms, out[3].end_ms) == (2000, 2999)
    assert out[2].end_ms <= out[3].start_ms


def test_empty_replacement_deletes_words_but_keeps_sentence_end():
    out = apply_corrections(ws("so um. we glued"), rules(g={"um": ""}), "s")
    assert [w.text for w in out] == ["so.", "we", "glued"]


def test_kept_phrase_is_left_exactly_as_it_is():
    r = [*rules(g={"craig": "Kreg"}), CorrectionRule(("craig", "jackson"), None, None)]
    words = ws("a Craig jig from craig, Jackson. Craig said")
    out = apply_corrections(words, r, "s")
    assert [w.text for w in out] == ["a", "Kreg", "jig", "from", "craig,", "Jackson.", "Kreg", "said"]
    assert out[4:6] == words[4:6]


def test_kept_phrase_beats_a_global_rule_of_the_same_length():
    r = [*rules(g={"tight bond": "Titebond"}), CorrectionRule(("tight", "bond"), None, None)]
    assert [w.text for w in apply_corrections(ws("a tight bond"), r, "s")] == ["a", "tight", "bond"]


def test_episode_rule_beats_a_kept_phrase():
    r = [*rules(e={"s1": {"craig": "Greg"}}), CorrectionRule(("craig", "jackson"), None, None)]
    assert [w.text for w in apply_corrections(ws("Craig Jackson"), r, "s1")] == ["Greg", "Jackson"]
    assert [w.text for w in apply_corrections(ws("Craig Jackson"), r, "s2")] == ["Craig", "Jackson"]


def test_keep_list_is_loaded(tmp_path):
    f = tmp_path / "c.yaml"
    f.write_text("global: {craig: Kreg}\nkeep:\n  - Craig Jackson\n  - '!'\n")
    assert set(load_corrections(f)) == {
        CorrectionRule(("craig",), "Kreg", None),
        CorrectionRule(("craig", "jackson"), None, None),
    }


def test_shipped_file_keeps_craig_jackson():
    out = apply_corrections(
        ws("Craig Jackson ran Craig tools"), load_corrections(CORRECTIONS_FILE), "s"
    )
    assert [w.text for w in out] == ["Craig", "Jackson", "ran", "Kreg", "tools"]


def test_yaml_keys_and_values_stay_text(tmp_path):
    f = tmp_path / "c.yaml"
    f.write_text("global:\n  no: nope\n  uh:\n  '1': one\n")
    assert set(load_corrections(f)) == {
        CorrectionRule(("no",), "nope", None),
        CorrectionRule(("uh",), "", None),
        CorrectionRule(("1",), "one", None),
    }


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
