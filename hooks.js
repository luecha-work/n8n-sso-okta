const { dirname, resolve } = require("path");

const { issueCookie } = require(
    resolve(dirname(require.resolve("n8n")), "auth/jwt"),
);
const ignoreAuthRegexp = /^\/(assets|healthz|webhook|rest\/oauth2-credential)/;

let Layer;
try {
    Layer = require("router/lib/layer");
} catch (routerError) {
    try {
        Layer = require("express/lib/router/layer");
    } catch (expressError) {
        console.warn(
            "Trusted header hook: could not load router layer module; SSO middleware not installed.",
            routerError,
            expressError,
        );
        Layer = null;
    }
}

module.exports = {
    n8n: {
        ready: [
            async function ({ app }, config) {
                if (!Layer) return;

                const router = app.router ?? app._router;
                if (!router?.stack?.splice) return;

                const index = router.stack.findIndex(
                    (layer) => layer.name === "cookieParser",
                );
                const insertIndex = index === -1 ? 0 : index + 1;

                router.stack.splice(
                    insertIndex,
                    0,
                    new Layer(
                        "/",
                        { strict: false, end: false },
                        async (req, res, next) => {
                            if (req.url.startsWith("/rest/logout")) {
                                const cookieName =
                                    process.env.N8N_FORWARD_AUTH_COOKIE_NAME ??
                                    "_oauth2_proxy";
                                const domain =
                                    process.env
                                        .N8N_FORWARD_AUTH_COOKIE_DOMAIN ??
                                    "localtest.me";
                                res.clearCookie("n8n-auth", {
                                    path: "/",
                                    sameSite: "lax",
                                    secure: true,
                                    httpOnly: true,
                                });
                                res.clearCookie(cookieName, {
                                    domain,
                                    path: "/",
                                    sameSite: "lax",
                                    secure: true,
                                    httpOnly: true,
                                });
                                return next();
                            }

                            if (ignoreAuthRegexp.test(req.url)) return next();

                            if (
                                !config.get(
                                    "userManagement.isInstanceOwnerSetUp",
                                    false,
                                )
                            )
                                return next();

                            if (req.cookies?.["n8n-auth"]) return next();

                            const headerName =
                                process.env.N8N_FORWARD_AUTH_HEADER?.toLowerCase();
                            if (!headerName) return next();

                            const email = req.headers[headerName];
                            if (!email) return next();

                            const user =
                                await this.dbCollections.User.findOneBy({
                                    email,
                                });
                            if (!user) {
                                res.statusCode = 401;
                                res.end(
                                    `User ${email} not found, please invite the user in n8n before enabling SSO.`,
                                );
                                return;
                            }

                            if (!user.role) {
                                user.role = {};
                            }

                            issueCookie(res, user);

                            return next();
                        },
                    ),
                );
            },
        ],
    },
};
