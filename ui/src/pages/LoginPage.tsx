import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router";
import { IconSchool } from "@tabler/icons-react";
import { Button, Card } from "erxes-ui";
import manifest from "../../../erxes.json" with { type: "json" };
import { login } from "../modules/auth";

type LocationState = { from?: { pathname: string } };

export const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from?.pathname ?? `/${manifest.ui.path}`;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Small delay so the button feedback is visible
    setTimeout(() => {
      if (login(username, password)) {
        navigate(from, { replace: true });
      } else {
        setError("Нэвтрэх нэр эсвэл нууц үг буруу байна.");
        setLoading(false);
      }
    }, 300);
  };

  return (
    <div className="subedei:flex subedei:min-h-screen subedei:items-center subedei:justify-center subedei:bg-background subedei:p-4">
      <div className="subedei:w-full subedei:max-w-sm">
        {/* Logo / brand */}
        <div className="subedei:mb-6 subedei:flex subedei:flex-col subedei:items-center subedei:gap-2">
          <div className="subedei:flex subedei:h-12 subedei:w-12 subedei:items-center subedei:justify-center subedei:rounded-xl subedei:bg-primary subedei:text-primary-foreground">
            <IconSchool size={28} />
          </div>
          <h1 className="subedei:text-xl subedei:font-semibold subedei:text-foreground">
            {manifest.title}
          </h1>
          <p className="subedei:text-sm subedei:text-muted-foreground">Системд нэвтрэх</p>
        </div>

        <Card>
          <Card.Content className="subedei:pt-6">
            <form onSubmit={handleSubmit} className="subedei:flex subedei:flex-col subedei:gap-4">
              {/* Username */}
              <div className="subedei:flex subedei:flex-col subedei:gap-1.5">
                <label
                  htmlFor="username"
                  className="subedei:text-sm subedei:font-medium subedei:text-foreground"
                >
                  Нэвтрэх нэр
                </label>
                <input
                  id="username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="subedei:h-9 subedei:w-full subedei:rounded-md subedei:border subedei:border-border subedei:bg-background subedei:px-3 subedei:text-sm subedei:text-foreground subedei:outline-none subedei:ring-ring subedei:transition-shadow focus:subedei:ring-2 disabled:subedei:opacity-50"
                />
              </div>

              {/* Password */}
              <div className="subedei:flex subedei:flex-col subedei:gap-1.5">
                <label
                  htmlFor="password"
                  className="subedei:text-sm subedei:font-medium subedei:text-foreground"
                >
                  Нууц үг
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="subedei:h-9 subedei:w-full subedei:rounded-md subedei:border subedei:border-border subedei:bg-background subedei:px-3 subedei:text-sm subedei:text-foreground subedei:outline-none subedei:ring-ring subedei:transition-shadow focus:subedei:ring-2 disabled:subedei:opacity-50"
                />
              </div>

              {/* Error */}
              {error && (
                <p role="alert" className="subedei:text-sm subedei:text-destructive">
                  {error}
                </p>
              )}

              <Button type="submit" className="subedei:w-full" disabled={loading}>
                {loading ? "Нэвтэрч байна…" : "Нэвтрэх"}
              </Button>
            </form>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
};
