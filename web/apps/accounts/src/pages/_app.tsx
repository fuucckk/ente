import { staticAppTitle } from "@/base/app";
import { assertionFailed } from "@/base/assert";
import { CustomHead } from "@/base/components/Head";
import { LoadingIndicator } from "@/base/components/loaders";
import { AttributedMiniDialog } from "@/base/components/MiniDialog";
import { useAttributedMiniDialog } from "@/base/components/utils/dialog";
import { useSetupI18n, useSetupLogs } from "@/base/components/utils/hooks-app";
import { photosTheme } from "@/base/components/utils/theme";
import { BaseContext } from "@/base/context";
import "@fontsource-variable/inter";
import { CssBaseline } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { t } from "i18next";
import type { AppProps } from "next/app";
import React, { useCallback, useMemo } from "react";
import { AppContext } from "../types/context";

const App: React.FC<AppProps> = ({ Component, pageProps }) => {
    useSetupLogs({ disableDiskLogs: true });

    const isI18nReady = useSetupI18n();
    const { showMiniDialog, miniDialogProps } = useAttributedMiniDialog();

    const logout = useCallback(() => {
        // No code in the accounts app is currently expected to reach a code
        // path where they would need to "logout". In any case, the accounts app
        // doesn't store any user specific persistent state that'd need to be
        // cleared, so there really isn't anything to do here.
        assertionFailed();
    }, []);

    const baseContext = useMemo(
        () => ({ showMiniDialog, logout }),
        [showMiniDialog, logout],
    );
    const appContext = useMemo(() => ({ showMiniDialog }), [showMiniDialog]);

    const title = isI18nReady ? t("title_accounts") : staticAppTitle;

    return (
        <ThemeProvider theme={photosTheme}>
            <CustomHead {...{ title }} />
            <CssBaseline enableColorScheme />
            <AttributedMiniDialog {...miniDialogProps} />

            <BaseContext value={baseContext}>
                <AppContext.Provider value={appContext}>
                    {!isI18nReady && <LoadingIndicator />}
                    {isI18nReady && <Component {...pageProps} />}
                </AppContext.Provider>
            </BaseContext>
        </ThemeProvider>
    );
};

export default App;
