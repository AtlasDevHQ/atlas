import { describe, expect, it } from "bun:test";
import { APIError } from "better-auth/api";
import {
  DUPLICATE_USER_REJECTION_CODES,
  isDuplicateUserRejection,
} from "../duplicate-user.js";

describe("isDuplicateUserRejection", () => {
  it("recognizes the APIError Better Auth signUpEmail throws for a registered email", () => {
    // Mirrors better-auth@1.6.x sign-up.mjs:
    //   throw APIError.from("UNPROCESSABLE_ENTITY",
    //     BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL)
    // which yields body = { code, message }.
    const err = APIError.from("UNPROCESSABLE_ENTITY", {
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "User already exists. Use another email.",
    });
    expect(isDuplicateUserRejection(err)).toBe(true);
  });

  it("recognizes the plainer USER_ALREADY_EXISTS code too", () => {
    const err = APIError.from("BAD_REQUEST", {
      code: "USER_ALREADY_EXISTS",
      message: "User already exists.",
    });
    expect(isDuplicateUserRejection(err)).toBe(true);
  });

  it("does not match a different APIError code (e.g. a business-email deny)", () => {
    const err = APIError.from("BAD_REQUEST", {
      code: "BUSINESS_EMAIL_REQUIRED",
      message: "Please sign up with your work email address.",
    });
    expect(isDuplicateUserRejection(err)).toBe(false);
  });

  it("does not match a plain Error (a generic, transient failure stays generic)", () => {
    expect(isDuplicateUserRejection(new Error("better auth exploded"))).toBe(false);
  });

  it("does not match non-error values", () => {
    expect(isDuplicateUserRejection(undefined)).toBe(false);
    expect(isDuplicateUserRejection(null)).toBe(false);
    expect(isDuplicateUserRejection("USER_ALREADY_EXISTS")).toBe(false);
    expect(isDuplicateUserRejection({ code: "USER_ALREADY_EXISTS" })).toBe(false);
  });

  it("exposes both recognized codes as the stable contract", () => {
    expect(DUPLICATE_USER_REJECTION_CODES.has("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")).toBe(true);
    expect(DUPLICATE_USER_REJECTION_CODES.has("USER_ALREADY_EXISTS")).toBe(true);
    expect(DUPLICATE_USER_REJECTION_CODES.has("SOMETHING_ELSE")).toBe(false);
  });
});
