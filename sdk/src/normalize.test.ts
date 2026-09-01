import { describe, expect, it } from "vitest";

import { namehash } from "./namehash.js";
import { normalize, QnsNameError } from "./normalize.js";

describe("normalize", () => {
  it("passes already normal names through unchanged", () => {
    expect(normalize("alice.qrl")).toBe("alice.qrl");
    expect(normalize("a-1.b2.qrl")).toBe("a-1.b2.qrl");
    expect(normalize("")).toBe("");
  });

  it("folds ASCII uppercase so case variants share one namehash", () => {
    expect(normalize("ALICE.qrl")).toBe("alice.qrl");
    expect(normalize("Alice.QRL")).toBe("alice.qrl");
    expect(namehash(normalize("ALICE.qrl"))).toEqual(
      namehash(normalize("alice.qrl")),
    );
  });

  it("rejects empty labels and dot edges", () => {
    expect(() => normalize(".qrl")).toThrow(QnsNameError);
    expect(() => normalize("qrl.")).toThrow(QnsNameError);
    expect(() => normalize("alice..qrl")).toThrow(QnsNameError);
  });

  it("rejects characters outside the conservative profile", () => {
    expect(() => normalize("al ice.qrl")).toThrow(QnsNameError);
    expect(() => normalize("al_ice.qrl")).toThrow(QnsNameError);
    expect(() => normalize("café.qrl")).toThrow(QnsNameError);
    expect(() => normalize("аlice.qrl")).toThrow(QnsNameError);
    expect(() => normalize("namｅ.qrl")).toThrow(QnsNameError);
    expect(() => normalize("hi\u{1F600}.qrl")).toThrow(QnsNameError);
  });

  it("rejects labels with the reserved double-hyphen pattern", () => {
    for (const name of ["ab--cd.qrl", "xn--name.qrl", "12--34.qrl"]) {
      expect(() => normalize(name)).toThrow(QnsNameError);
    }
    expect(normalize("a--b.qrl")).toBe("a--b.qrl");
  });
});
