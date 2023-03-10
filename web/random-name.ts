export function set_random_name() {
  if (!window.location.hash) {
      window.location.hash += ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
      window.location.hash += ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
      window.location.hash += ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
  }
}

const ANIMAL_NAMES = [
  "Albatross",
  "Alligator",
  "Alpaca",
  "Antelope",
  "Donkey",
  "Badger",
  "Bat",
  "Bear",
  "Bee",
  "Bison",
  "Buffalo",
  "Butterfly",
  "Camel",
  "Capybara",
  "Cat",
  "Cheetah",
  "Chicken",
  "Chinchilla",
  "Clam",
  "Cobra",
  "Crab",
  "Crane",
  "Crow",
  "Deer",
  "Dog",
  "Dolphin",
  "Dove",
  "Dragonfly",
  "Duck",
  "Eagle",
  "Elephant",
  "Elk",
  "Emu",
  "Falcon",
  "Ferret",
  "Finch",
  "Fish",
  "Flamingo",
  "Fox",
  "Frog",
  "Gazelle",
  "Gerbil",
  "Giraffe",
  "Goat",
  "Goldfish",
  "Goose",
  "Grasshopper",
  "Hamster",
  "Heron",
  "Horse",
  "Hyena",
  "Jaguar",
  "Jellyfish",
  "Kangaroo",
  "Koala",
  "Lemur",
  "Lion",
  "Lobster",
  "Manatee",
  "Mantis",
  "Meerkat",
  "Mongoose",
  "Moose",
  "Mouse",
  "Narwhal",
  "Octopus",
  "Okapi",
  "Otter",
  "Owl",
  "Panther",
  "Parrot",
  "Pelican",
  "Penguin",
  "Pony",
  "Porcupine",
  "Rabbit",
  "Raccoon",
  "Raven",
  "Salmon",
  "Seahorse",
  "Seal",
  "Shark",
  "Snake",
  "Sparrow",
  "Stingray",
  "Stork",
  "Swan",
  "Tiger",
  "Turtle",
  "Viper",
  "Walrus",
  "Wolf",
  "Wolverine",
  "Wombat",
  "Yak",
  "Zebra",
  "Gnome",
  "Unicorn",
  "Dragon",
  "Hippo",
];

const ADJECTIVES = [
  "Beefy",
  "Big",
  "Bold",
  "Brave",
  "Bright",
  "Buff",
  "Calm",
  "Charming",
  "Chill",
  "Creative",
  "Cute",
  "Cool",
  "Crafty",
  "Cunning",
  "Daring",
  "Elegant",
  "Excellent",
  "Fab",
  "Fluffy",
  "Grand",
  "Green",
  "Happy",
  "Heavy",
  "Honest",
  "Huge",
  "Humble",
  "Iconic",
  "Immense",
  "Jolly",
  "Jumbo",
  "Kind",
  "Little",
  "Loyal",
  "Lucky",
  "Majestic",
  "Noble",
  "Nefarious",
  "Odd",
  "Ornate",
  "Plucky",
  "Plump",
  "Polite",
  "Posh",
  "Quirky",
  "Quick",
  "Round",
  "Relaxed",
  "Rotund",
  "Shy",
  "Sleek",
  "Sly",
  "Spry",
  "Stellar",
  "Super",
  "Tactical",
  "Tidy",
  "Trendy",
  "Unique",
  "Vivid",
  "Wild",
  "Yappy",
  "Young",
  "Zany",
  "Zesty",
];
