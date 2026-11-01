import { animals, colors, uniqueNamesGenerator } from "unique-names-generator";

export function generateName(id: string) {
  return uniqueNamesGenerator({
    dictionaries: [colors, animals],
    separator: " ",
    style: "capital",
    seed: id,
  });
}
