import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixError } from 'matrix-js-sdk';
import { registerAccount, RegistrationError, usernameProblem } from './registration';

const register = vi.fn();
const isUsernameAvailable = vi.fn(async () => true);

vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: () => ({ register, isUsernameAvailable }) };
});
vi.mock('./session', () => ({ setSession: vi.fn() }));

const TOKEN_STAGE = 'm.login.registration_token';

function uiaChallenge(extra: Record<string, unknown> = {}): MatrixError {
  return new MatrixError(
    { session: 'sess1', flows: [{ stages: [TOKEN_STAGE] }], params: {}, ...extra },
    401
  );
}

function prompts(tokens: (string | null)[]) {
  const enterRegistrationToken = vi.fn(async () => tokens.shift() ?? null);
  return {
    acceptTerms: vi.fn(),
    verifyEmail: vi.fn(),
    enterRegistrationToken,
  };
}

describe('registerAccount — registration token stage', () => {
  beforeEach(() => register.mockReset());

  it('sends the token the user entered and completes', async () => {
    register
      .mockRejectedValueOnce(uiaChallenge())
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = prompts(['invite-123']);

    const session = await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(session.userId).toBe('@a:x');
    expect(register).toHaveBeenLastCalledWith('a', 'password1', 'sess1', {
      type: TOKEN_STAGE,
      token: 'invite-123',
      session: 'sess1',
    });
    expect(p.enterRegistrationToken).toHaveBeenCalledWith(undefined);
  });

  it("re-asks with the server's error after a wrong token", async () => {
    register
      .mockRejectedValueOnce(uiaChallenge())
      .mockRejectedValueOnce(uiaChallenge({ errcode: 'M_FORBIDDEN', error: 'Invalid registration token' }))
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = prompts(['wrong', 'right']);

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.enterRegistrationToken).toHaveBeenNthCalledWith(2, 'Invalid registration token');
    expect(register.mock.calls[2][3]).toMatchObject({ token: 'right' });
  });

  it('gives up cleanly when the user cancels the token prompt', async () => {
    register.mockRejectedValueOnce(uiaChallenge());

    await expect(registerAccount('https://hs.example', 'a', 'password1', prompts([null]))).rejects.toBeInstanceOf(
      RegistrationError
    );
    expect(register).toHaveBeenCalledTimes(1);
  });
});

const EMAIL_STAGE = 'm.login.email.identity';

describe('registerAccount — email stage', () => {
  beforeEach(() => register.mockReset());

  const emailChallenge = (extra: Record<string, unknown> = {}) =>
    new MatrixError(
      {
        session: 'sess1',
        flows: [{ stages: [TOKEN_STAGE, EMAIL_STAGE] }],
        completed: [TOKEN_STAGE],
        params: {},
        ...extra,
      },
      401
    );

  it('sends the verified sid/client secret, and resumes the same address when the link was not clicked yet', async () => {
    const first = { email: 'a@example.com', sessions: [{ sid: 's1', clientSecret: 'c1' }] };
    register
      .mockRejectedValueOnce(emailChallenge())
      .mockRejectedValueOnce(
        emailChallenge({ errcode: 'M_THREEPID_AUTH_FAILED', error: 'This email address has not been validated.' })
      )
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = { ...prompts([]), verifyEmail: vi.fn(async () => first) };

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.verifyEmail).toHaveBeenNthCalledWith(1, expect.anything(), undefined);
    expect(p.verifyEmail).toHaveBeenNthCalledWith(2, expect.anything(), {
      previous: first,
      error: 'This email address has not been validated.',
    });
    expect(register.mock.calls[2][3]).toEqual({
      type: EMAIL_STAGE,
      session: 'sess1',
      threepid_creds: { sid: 's1', client_secret: 'c1' },
    });
  });

  it('tries the session of every email sent before asking again — the clicked link may be in an older one', async () => {
    const sent = {
      email: 'a@example.com',
      sessions: [
        { sid: 's2', clientSecret: 'c2' },
        { sid: 's1', clientSecret: 'c1' },
      ],
    };
    const notValidated = { errcode: 'M_THREEPID_AUTH_FAILED', error: 'This email address has not been validated.' };
    register
      .mockRejectedValueOnce(emailChallenge())
      .mockRejectedValueOnce(emailChallenge(notValidated))
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = { ...prompts([]), verifyEmail: vi.fn(async () => sent) };

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.verifyEmail).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[1][3]).toMatchObject({ threepid_creds: { sid: 's2', client_secret: 'c2' } });
    expect(register.mock.calls[2][3]).toMatchObject({ threepid_creds: { sid: 's1', client_secret: 'c1' } });
  });

  it('asks again once every session has been turned down', async () => {
    const sent = {
      email: 'a@example.com',
      sessions: [
        { sid: 's2', clientSecret: 'c2' },
        { sid: 's1', clientSecret: 'c1' },
      ],
    };
    const notValidated = { errcode: 'M_THREEPID_AUTH_FAILED', error: 'This email address has not been validated.' };
    register
      .mockRejectedValueOnce(emailChallenge())
      .mockRejectedValueOnce(emailChallenge(notValidated))
      .mockRejectedValueOnce(emailChallenge(notValidated))
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = { ...prompts([]), verifyEmail: vi.fn(async () => sent) };

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.verifyEmail).toHaveBeenNthCalledWith(2, expect.anything(), { previous: sent, error: notValidated.error });
    expect(register.mock.calls[3][3]).toMatchObject({ threepid_creds: { sid: 's2', client_secret: 'c2' } });
  });

  it('takes the email-only route over the invite-code one when the server offers both', async () => {
    const creds = { email: 'a@example.com', sessions: [{ sid: 's1', clientSecret: 'c1' }] };
    register
      .mockRejectedValueOnce(
        new MatrixError(
          { session: 'sess1', flows: [{ stages: [TOKEN_STAGE] }, { stages: [EMAIL_STAGE] }], params: {} },
          401
        )
      )
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = { ...prompts([]), verifyEmail: vi.fn(async () => creds) };

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.enterRegistrationToken).not.toHaveBeenCalled();
    expect(register.mock.calls[1][3]).toMatchObject({ type: EMAIL_STAGE });
  });
});

describe('usernameProblem', () => {
  it('accepts what a Matrix user ID allows', () => {
    expect(usernameProblem('wyrd')).toBeNull();
    expect(usernameProblem('a.b_c=d-e/f+9')).toBeNull();
  });

  it('suggests the lowercase name when capitals are the only problem', () => {
    expect(usernameProblem('Wyrd')).toBe('Usernames can only use lowercase letters. Try "wyrd" instead.');
  });

  it('names spaces and other characters', () => {
    expect(usernameProblem('wy rd')).toBe("Usernames can't contain spaces.");
    expect(usernameProblem('wyrd!')).toMatch(/lowercase letters \(a-z\), numbers/);
    expect(usernameProblem('')).toBe('Enter a username.');
  });
});

describe('registerAccount — username checks before the flow starts', () => {
  beforeEach(() => {
    register.mockReset();
    isUsernameAvailable.mockReset().mockResolvedValue(true);
  });

  it('refuses a name with capitals without contacting the server', async () => {
    const p = prompts([]);
    await expect(registerAccount('https://hs.example', 'Wyrd', 'password1', p)).rejects.toThrow(
      'Usernames can only use lowercase letters. Try "wyrd" instead.'
    );
    expect(isUsernameAvailable).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('stops on a taken name before any email or token prompt', async () => {
    isUsernameAvailable.mockResolvedValue(false);
    const p = prompts(['invite-123']);
    await expect(registerAccount('https://hs.example', 'wyrd', 'password1', p)).rejects.toThrow(
      'The username "wyrd" is taken. Try another.'
    );
    expect(register).not.toHaveBeenCalled();
    expect(p.verifyEmail).not.toHaveBeenCalled();
  });

  it("rewords the server's invalid-username error", async () => {
    isUsernameAvailable.mockRejectedValue(
      new MatrixError({ errcode: 'M_INVALID_USERNAME', error: 'identifier contains invalid characters' }, 400)
    );
    await expect(registerAccount('https://hs.example', '_wyrd', 'password1', prompts([]))).rejects.toThrow(
      "That username can't be used: identifier contains invalid characters"
    );
  });

  it('carries on when the server has no availability check', async () => {
    isUsernameAvailable.mockRejectedValue(new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404));
    register.mockResolvedValueOnce({ user_id: '@wyrd:x', device_id: 'D', access_token: 'T' });
    const session = await registerAccount('https://hs.example', 'wyrd', 'password1', prompts([]));
    expect(session.userId).toBe('@wyrd:x');
  });

  it('rewords an invalid-username error from register itself', async () => {
    register.mockRejectedValueOnce(
      new MatrixError({ errcode: 'M_INVALID_USERNAME', error: 'Username is reserved' }, 400)
    );
    await expect(registerAccount('https://hs.example', 'wyrd', 'password1', prompts([]))).rejects.toThrow(
      "That username can't be used: Username is reserved"
    );
  });
});
