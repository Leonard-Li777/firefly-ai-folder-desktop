/**
 * Alert组件
 * 基于shadcn/ui的Alert组件实现
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * Alert变体样式
 */
const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive:
          'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
        warning:
          'border-yellow-500/50 text-yellow-700 bg-yellow-50 dark:border-yellow-500 dark:text-yellow-400 dark:bg-yellow-950/20 [&>svg]:text-yellow-600 dark:[&>svg]:text-yellow-400',
        success:
          'border-green-500/50 text-green-700 bg-green-50 dark:border-green-500 dark:text-green-400 dark:bg-green-950/20 [&>svg]:text-green-600 dark:[&>svg]:text-green-400',
        info:
          'border-blue-500/50 text-blue-700 bg-blue-50 dark:border-blue-500 dark:text-blue-400 dark:bg-blue-950/20 [&>svg]:text-blue-600 dark:[&>svg]:text-blue-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

/**
 * Alert组件Props接口
 */
export interface IAlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

/**
 * Alert组件
 */
const Alert = React.forwardRef<HTMLDivElement, IAlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
);
Alert.displayName = 'Alert';

/**
 * AlertTitle组件Props接口
 */
export interface IAlertTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

/**
 * AlertTitle组件
 */
const AlertTitle = React.forwardRef<HTMLParagraphElement, IAlertTitleProps>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn('mb-1 font-medium leading-none tracking-tight', className)}
      {...props}
    />
  )
);
AlertTitle.displayName = 'AlertTitle';

/**
 * AlertDescription组件Props接口
 */
export interface IAlertDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}

/**
 * AlertDescription组件
 */
const AlertDescription = React.forwardRef<HTMLParagraphElement, IAlertDescriptionProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('text-sm [&_p]:leading-relaxed', className)}
      {...props}
    />
  )
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };