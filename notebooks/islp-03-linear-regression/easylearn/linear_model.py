import pandas as pd
import numpy as np
from scipy import stats


class LinearRegression:
    """Educational OLS implementation used by the accompanying notebook."""

    def __init__(self, fit_intercept=True):
        self.fit_intercept = fit_intercept                  # the SWITCH

    def _design_matrix(self, X):
        """Coerce X to a 2-D float array and (optionally) prepend a column of 1s."""
        X = np.asarray(X, dtype=float)
        if X.ndim == 1:                                     # a single feature passed as a flat vector
            X = X.reshape(-1, 1)
        if self.fit_intercept:
            X = np.column_stack([np.ones(X.shape[0]), X])
        return X

    def _normal_equation(self, X, y):
        return np.linalg.inv(X.T @ X) @ X.T @ y

    def fit(self, X, y):
        Xd = self._design_matrix(X)
        y = np.asarray(y, dtype=float)
        beta = self._normal_equation(Xd, y)
        self._Xd = Xd
        self.n_ = Xd.shape[0]
        self._beta = beta
        self.y_ = y
        self.fitted_values_ = Xd @ beta
        self.resid_ = y - self.fitted_values_

        n_features = Xd.shape[1] - (1 if self.fit_intercept else 0)
        self.feature_names_ = (list(X.columns) if hasattr(X, "columns")
                               else [f"x{i+1}" for i in range(n_features)])

        if self.fit_intercept:
            self.intercept_ = beta[0]
            self.coef_ = beta[1:]
        else:
            self.intercept_ = 0.0
            self.coef_ = beta
        return self

    def predict(self, X):
        X = np.asarray(X, dtype=float)
        if X.ndim == 1:
            X = X.reshape(-1, 1)
        return self.intercept_ + X @ self.coef_

    # ---------- inference (Table 3.1 / 3.4) ----------

    def rss_(self):
        """Residual sum of squares, Σ eᵢ²."""
        return np.sum(self.resid_ ** 2)

    def sigma2_(self):
        """Unbiased noise variance σ̂² = RSS / (n − k)."""
        n, k = self.n_, self._Xd.shape[1]     # k counts the intercept column when present
        return self.rss_() / (n - k)

    def residual_standard_error(self):
        return np.sqrt(self.sigma2_())

    def tss_(self):
        return np.sum((self.y_ - np.mean(self.y_)) ** 2)

    def R_squared(self):
        return 1 - self.rss_() / self.tss_()

    def se_coef_(self):
        """Standard errors √diag(σ̂² (XᵀX)⁻¹), ordered [intercept, *slopes]."""
        var_beta = self.sigma2_() * np.linalg.inv(self._Xd.T @ self._Xd)
        return np.sqrt(np.diag(var_beta))

    def t_values_(self):
        """t-statistic for H₀: βⱼ = 0  →  β̂ⱼ / SE(β̂ⱼ)."""
        return self._beta / self.se_coef_()

    def p_values_(self):
        """Two-sided p-values from the t-distribution."""
        df = self.n_ - self._Xd.shape[1]
        return 2 * stats.t.sf(np.abs(self.t_values_()), df)

    def summary(self):
        """The parameter table — ISLP Table 3.1 / 3.4."""
        names = (["intercept"] + self.feature_names_) if self.fit_intercept else self.feature_names_
        return pd.DataFrame({
            "coef": self._beta,
            "std err": self.se_coef_(),
            "t": self.t_values_(),
            "P>|t|": self.p_values_(),
        }, index=names)
