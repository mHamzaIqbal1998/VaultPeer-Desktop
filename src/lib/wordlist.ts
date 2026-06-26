/**
 * Compact wordlist for Diceware-style passphrase generation (PLAN Phase 5).
 *
 * 256 short, common, unambiguous English words — a clean 8 bits of entropy per
 * word. Entropy is computed from the live list length (see `passwordGenerator`),
 * so the count here is the single source of truth.
 */
export const WORDLIST: string[] = [
  "able", "acid", "acorn", "actor", "agent", "album", "alert", "alien",
  "alley", "amber", "angle", "ankle", "apple", "april", "apron", "arbor",
  "arch", "arena", "armor", "arrow", "aspen", "atlas", "atom", "aunt",
  "axis", "bacon", "badge", "bagel", "baker", "balsa", "banjo", "barge",
  "basil", "basin", "batch", "beach", "beam", "bean", "bear", "beaver",
  "berry", "birch", "bird", "bison", "blade", "blaze", "bloom", "board",
  "boat", "bolt", "bonus", "boot", "brave", "bread", "brick", "brook",
  "brush", "bunny", "cabin", "cable", "cacao", "cadet", "camel", "candy",
  "canoe", "canon", "cargo", "carol", "cedar", "chair", "chalk", "charm",
  "cheek", "chess", "chick", "chili", "chord", "cider", "clamp", "claw",
  "clay", "clerk", "cliff", "cloak", "clock", "cloud", "clove", "clover",
  "coast", "cobra", "cocoa", "comet", "coral", "couch", "cove", "crane",
  "crate", "cream", "creek", "crest", "crisp", "crow", "cube", "curve",
  "daisy", "dancer", "dawn", "deer", "delta", "denim", "diary", "diner",
  "ditch", "dock", "dove", "draft", "drum", "dune", "eagle", "earth",
  "easel", "ebony", "elbow", "elder", "elf", "elm", "ember", "envoy",
  "epoch", "fable", "fairy", "fang", "fawn", "fern", "ferry", "field",
  "finch", "flame", "flask", "fleet", "flint", "flute", "foam", "forge",
  "fox", "frost", "fruit", "gauge", "ginger", "glade", "globe", "glove",
  "gnome", "goose", "grape", "grove", "guava", "harbor", "hawk", "hazel",
  "heron", "hill", "honey", "hound", "ivory", "ivy", "jade", "jasmine",
  "jelly", "jewel", "joker", "juice", "kayak", "kettle", "kiwi", "koala",
  "lake", "lamp", "lance", "lark", "leaf", "ledge", "lemon", "lily",
  "linen", "lion", "llama", "lobby", "lotus", "lunar", "lynx", "mango",
  "maple", "marble", "marsh", "mason", "meadow", "melon", "mesa", "mint",
  "mist", "moose", "moss", "motto", "mural", "navy", "nectar", "nest",
  "noble", "north", "oasis", "oat", "ocean", "olive", "onyx", "opal",
  "orbit", "otter", "owl", "palm", "panda", "pansy", "peach", "pearl",
  "pecan", "perch", "petal", "piano", "pilot", "pine", "pixel", "plaza",
  "plum", "pond", "poppy", "prism", "puma", "quail", "quartz", "quill",
  "quilt", "radar", "raft", "rapid", "raven", "reed", "reef", "ridge",
  "river", "robin", "rose", "ruby", "sage", "sail", "salt", "sand",
];
