/** "1 issue", "2 issues": English plural for user-facing text. */
export const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
