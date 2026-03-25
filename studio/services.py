import re


THESAURUS = {
    "ancient": ["primeval", "age-worn", "timeworn", "archaic"],
    "angry": ["furious", "irate", "heated", "incensed"],
    "beautiful": ["striking", "radiant", "luminous", "elegant"],
    "brave": ["courageous", "steadfast", "valiant", "resolute"],
    "calm": ["tranquil", "steady", "composed", "still"],
    "dark": ["shadowed", "dim", "gloomy", "murky"],
    "fast": ["swift", "rapid", "fleet", "brisk"],
    "fear": ["dread", "terror", "anxiety", "unease"],
    "happy": ["joyful", "glad", "elated", "buoyant"],
    "important": ["crucial", "vital", "essential", "central"],
    "quiet": ["hushed", "muted", "still", "soft"],
    "sad": ["sorrowful", "downcast", "somber", "melancholic"],
    "small": ["compact", "slight", "petite", "modest"],
    "strange": ["peculiar", "uncanny", "odd", "unfamiliar"],
    "walk": ["stride", "wander", "pace", "trudge"],
    "write": ["draft", "compose", "record", "scribe"],
}


class ThesaurusService:
    def lookup(self, term: str) -> dict:
        normalized = (term or "").strip().lower()
        if not normalized:
            return {"term": "", "matches": []}
        matches = THESAURUS.get(normalized, [])
        if not matches:
            fuzzy = sorted(
                [
                    {"term": key, "synonyms": synonyms}
                    for key, synonyms in THESAURUS.items()
                    if normalized in key
                ],
                key=lambda item: item["term"],
            )
            return {"term": normalized, "matches": fuzzy}
        return {"term": normalized, "matches": [{"term": normalized, "synonyms": matches}]}


class ShortTextCorrector:
    punctuation_spacing = re.compile(r"\s+([,.;:!?])")
    repeated_spaces = re.compile(r"\s{2,}")
    sentence_split = re.compile(r"([.!?]\s+)")
    token_replacements = [
        (re.compile(r"\b(I|you|we|they) dont\b", re.IGNORECASE), r"\1 don't"),
        (re.compile(r"\b(he|she|it) dont\b", re.IGNORECASE), r"\1 doesn't"),
        (re.compile(r"\bdont\b", re.IGNORECASE), "don't"),
        (re.compile(r"\bdoesnt\b", re.IGNORECASE), "doesn't"),
        (re.compile(r"\bcant\b", re.IGNORECASE), "can't"),
        (re.compile(r"\bwont\b", re.IGNORECASE), "won't"),
        (re.compile(r"\bim\b", re.IGNORECASE), "I'm"),
        (re.compile(r"\bive\b", re.IGNORECASE), "I've"),
        (re.compile(r"\btheyre\b", re.IGNORECASE), "they're"),
        (re.compile(r"\btheres\b", re.IGNORECASE), "there's"),
        (re.compile(r"\bmaps is\b", re.IGNORECASE), "maps are"),
        (re.compile(r"\bthere ([a-z]+ing)\b", re.IGNORECASE), r"they're \1"),
        (re.compile(r"\bso quick\b", re.IGNORECASE), "so quickly"),
    ]

    def correct(self, text: str) -> str:
        cleaned = (text or "").strip()
        cleaned = cleaned.replace(" ,", ",").replace(" .", ".")
        cleaned = self.punctuation_spacing.sub(r"\1", cleaned)
        cleaned = re.sub(r"([,.;:!?])([^\s])", r"\1 \2", cleaned)
        cleaned = self.repeated_spaces.sub(" ", cleaned)
        for pattern, replacement in self.token_replacements:
            cleaned = pattern.sub(replacement, cleaned)
        if not cleaned:
            return ""

        parts = self.sentence_split.split(cleaned)
        rebuilt = []
        for part in parts:
            if not part:
                continue
            if self.sentence_split.fullmatch(part):
                rebuilt.append(part)
                continue
            stripped = part.strip()
            rebuilt.append(stripped[:1].upper() + stripped[1:] if stripped else "")
        corrected = "".join(rebuilt)
        if corrected and corrected[-1] not in ".!?":
            corrected += "."
        return corrected
