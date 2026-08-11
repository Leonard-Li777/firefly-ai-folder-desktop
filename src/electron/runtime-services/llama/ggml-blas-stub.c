/**
 * ggml-blas-stub.c
 * macOS Monterey (12.x) 兼容性存根：替换任意使用 Accelerate.framework 新版 LAPACK API
 * (cblas_sgemm$NEWLAPACK$ILP64) 的 libggml-blas，回退到 CPU 后端。
 * 
 * llama.cpp build b9190 在 macOS 13+ SDK 下编译，生成的 libggml-blas 依赖
 * Accelerate.framework 中的 _cblas_sgemm$NEWLAPACK$ILP64 符号，
 * 该符号在 macOS 12.x 及更早版本中不存在。
 * 
 * 此存根导出 ggml BLAS 后端所需的 4 个符号，但不实际链接 Accelerate，
 * 使 ggml 在加载后端时发现 BLAS 不可用，自动回退至 CPU 后端。
 */

#include <stdint.h>

/* ggml BLAS backend 期望的 4 个导出符号 */
int ggml_backend_blas_init(void)   { return 0; }
int ggml_backend_is_blas(void)     { return 0; }
void ggml_backend_blas_reg(void)   {}
void ggml_backend_blas_set_n_threads(int n_threads) { (void)n_threads; }
