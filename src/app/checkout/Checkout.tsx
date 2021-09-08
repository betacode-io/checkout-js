/* eslint-disable react/no-unused-state */
/* eslint-disable @typescript-eslint/tslint/config */
/* eslint-disable react/jsx-no-bind */
import { Address, Cart, CartChangedError, CheckoutParams, CheckoutSelectors, Consignment, EmbeddedCheckoutMessenger, EmbeddedCheckoutMessengerOptions, FlashMessage, Promotion, RequestOptions, StepTracker } from '@bigcommerce/checkout-sdk';
import classNames from 'classnames';
import { find, findIndex } from 'lodash';
import React, { lazy, Component, ReactNode } from 'react';

import { StaticBillingAddress } from '../billing';
import { EmptyCartMessage } from '../cart';
import { isCustomError, CustomError, ErrorLogger, ErrorModal } from '../common/error';
import { retry } from '../common/utility';
import { CustomerInfo, CustomerSignOutEvent, CustomerViewType } from '../customer';
import { isEmbedded, EmbeddedCheckoutStylesheet } from '../embeddedCheckout';
import { withLanguage, TranslatedString, WithLanguageProps } from '../locale';
import { PromotionBannerList } from '../promotion';
import { hasSelectedShippingOptions, isUsingMultiShipping, StaticConsignment } from '../shipping';
import { ShippingOptionExpiredError } from '../shipping/shippingOption';
import { Button } from '../ui/button';
import { Fieldset, Label, TextInput } from '../ui/form';
import { LazyContainer, LoadingNotification, LoadingOverlay } from '../ui/loading';
import { Modal, ModalHeader } from '../ui/modal';
import { MobileView } from '../ui/responsive';

import mapToCheckoutProps from './mapToCheckoutProps';
import navigateToOrderConfirmation from './navigateToOrderConfirmation';
import withCheckout from './withCheckout';
import CheckoutStep from './CheckoutStep';
import CheckoutStepStatus from './CheckoutStepStatus';
import CheckoutStepType from './CheckoutStepType';
import CheckoutSupport from './CheckoutSupport';

const Billing = lazy(() => retry(() => import(
    /* webpackChunkName: "billing" */
    '../billing/Billing'
)));

const CartSummary = lazy(() => retry(() => import(
    /* webpackChunkName: "cart-summary" */
    '../cart/CartSummary'
)));

const CartSummaryDrawer = lazy(() => retry(() => import(
    /* webpackChunkName: "cart-summary-drawer" */
    '../cart/CartSummaryDrawer'
)));

const Customer = lazy(() => retry(() => import(
    /* webpackChunkName: "customer" */
    '../customer/Customer'
)));

const Payment = lazy(() => retry(() => import(
    /* webpackChunkName: "payment" */
    '../payment/Payment'
)));

const Shipping = lazy(() => retry(() => import(
    /* webpackChunkName: "shipping" */
    '../shipping/Shipping'
)));

export interface CheckoutProps {
    checkoutId: string;
    containerId: string;
    embeddedStylesheet: EmbeddedCheckoutStylesheet;
    embeddedSupport: CheckoutSupport;
    errorLogger: ErrorLogger;
    createEmbeddedMessenger(options: EmbeddedCheckoutMessengerOptions): EmbeddedCheckoutMessenger;
    createStepTracker(): StepTracker;
}

export interface CheckoutState {
    activeStepType?: CheckoutStepType;
    isBillingSameAsShipping: boolean;
    customerViewType?: CustomerViewType;
    defaultStepType?: CheckoutStepType;
    error?: Error;
    flashMessages?: FlashMessage[];
    isMultiShippingMode: boolean;
    isCartEmpty: boolean;
    isRedirecting: boolean;
    hasSelectedShippingOptions: boolean;
    openRestrictedModal: boolean;
    quoteType: string;
    message: string;
    completeCustomizedCart: boolean,
    public_url: string;
}

export interface WithCheckoutProps {
    billingAddress?: Address;
    cart?: Cart;
    consignments?: Consignment[];
    error?: Error;
    hasCartChanged: boolean;
    flashMessages?: FlashMessage[];
    isGuestEnabled: boolean;
    isLoadingCheckout: boolean;
    isPending: boolean;
    loginUrl: string;
    createAccountUrl: string;
    canCreateAccountInCheckout: boolean;
    promotions?: Promotion[];
    steps: CheckoutStepStatus[];
    clearError(error?: Error): void;
    loadCheckout(id: string, options?: RequestOptions<CheckoutParams>): Promise<CheckoutSelectors>;
    subscribeToConsignments(subscriber: (state: CheckoutSelectors) => void): () => void;
}


export interface ParamOrder {
    checkoutId: string;
    public_url: string;
    quoteType: string;
    message: string;
}

class Checkout extends Component<CheckoutProps & WithCheckoutProps & WithLanguageProps, CheckoutState> {
    stepTracker: StepTracker | undefined;

    state: CheckoutState = {
        isBillingSameAsShipping: true,
        isCartEmpty: false,
        isRedirecting: false,
        isMultiShippingMode: false,
        hasSelectedShippingOptions: false,
        openRestrictedModal: true,
        quoteType: 'screen',
        message: '',
        completeCustomizedCart: false,
        public_url: ''
    };

    private embeddedMessenger?: EmbeddedCheckoutMessenger;
    private unsubscribeFromConsignments?: () => void;

    componentWillUnmount(): void {
        if (this.unsubscribeFromConsignments) {
            this.unsubscribeFromConsignments();
            this.unsubscribeFromConsignments = undefined;
        }
    }

    async componentDidMount(): Promise<void> {
        const {
            checkoutId,
            containerId,
            createStepTracker,
            createEmbeddedMessenger,
            embeddedStylesheet,
            loadCheckout,
            subscribeToConsignments,
        } = this.props;

        try {
            const { data } = await loadCheckout(checkoutId, {
                params: {
                    include: [
                        'cart.lineItems.physicalItems.categoryNames',
                        'cart.lineItems.digitalItems.categoryNames',
                    ] as any, // FIXME: Currently the enum is not exported so it can't be used here.
                },
            });
            const { links: { siteLink = '' } = {} } = data.getConfig() || {};
            const errorFlashMessages = data.getFlashMessages('error') || [];

            if (errorFlashMessages.length) {
                const { language } = this.props;

                this.setState({
                    error: new CustomError({
                        title: errorFlashMessages[0].title || language.translate('common.error_heading'),
                        message: errorFlashMessages[0].message,
                        data: {},
                        name: 'default',
                    }),
                });
            }

            const messenger = createEmbeddedMessenger({ parentOrigin: siteLink });

            this.unsubscribeFromConsignments = subscribeToConsignments(this.handleConsignmentsUpdated);
            this.embeddedMessenger = messenger;
            messenger.receiveStyles(styles => embeddedStylesheet.append(styles));
            messenger.postFrameLoaded({ contentId: containerId });
            messenger.postLoaded();

            this.stepTracker = createStepTracker();
            this.stepTracker.trackCheckoutStarted();

            const consignments = data.getConsignments();
            const cart = data.getCart();
            const hasMultiShippingEnabled = data.getConfig()?.checkoutSettings?.hasMultiShippingEnabled;
            const isMultiShippingMode = !!cart &&
                !!consignments &&
                hasMultiShippingEnabled &&
                isUsingMultiShipping(consignments, cart.lineItems);

            if (isMultiShippingMode) {
                this.setState({ isMultiShippingMode }, this.handleReady);
            } else {
                this.handleReady();
            }
        } catch (error) {
            this.handleUnhandledError(error);
        }
    }

    onSubmitForm = async () => {
        const {checkoutId} = this.props
        const {public_url, quoteType, message } = this.state
        console.log(this.props)
        // eslint-disable-next-line react/destructuring-assignment
        console.log(this.state)
        // eslint-disable-next-line react/destructuring-assignment
        console.log(this.state.public_url)
        const body: any ={
            checkoutId: checkoutId || '' ,
            public_url: public_url || '' ,
            quoteType: quoteType || '',
            message: message || ''
        }
        console.log(JSON.stringify(body))
        await fetch("http://localhost:3000/api/v1/orders/checkout", {
            method: 'POST', 
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
              },
            body: JSON.stringify(body)
        })
        .then((result) => {
            console.log(result)
            this.setState({completeCustomizedCart: true})
        })

      };

    onChangeFile = async (selectorFiles: any) => {
        console.log(selectorFiles.target.files[0]);
        const file = selectorFiles.target.files[0]
        let status: number | null = null
        await fetch(`http://localhost:3000/api/v1/attachments/presigned_url?filename=${file.name}`)
        .then(res => {
            status = res.status
            return res.json()})
        .then(
            async (result: any) => {
                console.log(status)
                console.log(result.presigned_url)
                console.log(result.public_url)
                const public_url = result.public_url
                if(status === 200){
                    
                    // Create an object of formData
                    const formData = new FormData();
                    
                    // Update the formData object
                    formData.append(
                        "myFile",
                        file,
                        file.name
                    );
                    await fetch(result.presigned_url, {method: 'PUT', body: file})
                    .then((result) => {
                        this.setState({public_url: public_url})
                        console.log(result.status)
                    })
                }
              }
        )
    }

    render(): ReactNode {
        const { error, openRestrictedModal, completeCustomizedCart } = this.state;
        let errorModal = null;

        if (error) {
            if (isCustomError(error)) {
                errorModal = <ErrorModal error={ error } onClose={ this.handleCloseErrorModal } title={ error.title } />;
            } else {
                errorModal = <ErrorModal error={ error } onClose={ this.handleCloseErrorModal } />;
            }
        }

        return <>
            <div className={ classNames({ 'is-embedded': isEmbedded() }) }>
                <div className="layout optimizedCheckout-contentPrimary">
                    { completeCustomizedCart ? 
                    <div style={ {marginTop: 30 + 'px', fontSize: 30 + 'px'} }>
                    Thanks for requesting the quotation. Your info have been saved. Our internal team will contact you later. Thank you.
                    </div>
                    :

                    this.renderContent() }
                </div>
                <Modal
                    additionalModalClassName="modal--error"
                            // footer={ this.renderFooter() }
                    header={ this.renderHeader() }
                    isOpen={ openRestrictedModal }
                >
                            <div>
                                One or more products in your cart must be customized with embroidery or screen printing. This is required on Nike products. Please complete the quote request below for a free, no obligation price. You may also call or email for additional details.
                            </div>
                            <Button
                                // disabled={ isLoading }
                                id="checkout-save-address"
                                // variant={ ButtonVariant.Primary }
                                // eslint-disable-next-line react/jsx-no-bind
                                onClick = { () => this.setState({openRestrictedModal: !openRestrictedModal}) }
                                style={ {
                                    float: 'right',
                                    marginTop: 20 + 'px',
                                    marginBottom: 20 + 'px',
                                } }
                            >
                            Got It
                            </Button>
                        </Modal>
                { errorModal }
            </div>

        </>;
    }

    private renderContent(): ReactNode {
        const {
            isPending,
            loginUrl,
            promotions = [],
            steps,
        } = this.props;

        const {
            activeStepType,
            defaultStepType,
            isCartEmpty,
            isRedirecting,
        } = this.state;

        if (isCartEmpty) {
            return (
                <EmptyCartMessage
                    loginUrl={ loginUrl }
                    waitInterval={ 3000 }
                />
            );
        }

        return (
            <LoadingOverlay
                hideContentWhenLoading
                isLoading={ isRedirecting }
            >
                <div className="layout-main">
                    <LoadingNotification isLoading={ isPending } />

                    <PromotionBannerList promotions={ promotions } />

                    <ol className="checkout-steps">
                        { steps
                            .filter(step => step.isRequired)
                            .map(step => this.renderStep({
                                ...step,
                                isActive: activeStepType ? activeStepType === step.type : defaultStepType === step.type,
                            })) }
                    </ol>
                </div>

                { this.renderCartSummary() }
            </LoadingOverlay>
        );
    }

    private renderStep(step: CheckoutStepStatus): ReactNode {
        switch (step.type) {
        case CheckoutStepType.Customer:
            return this.renderCustomerStep(step);

        case CheckoutStepType.Shipping:
            return this.renderShippingStep(step);

        case CheckoutStepType.Billing:
            return this.renderBillingStep(step);

        case CheckoutStepType.Payment:
            return this.renderPaymentStep(step);

        default:
            return null;
        }
    }

    private renderCustomerStep(step: CheckoutStepStatus): ReactNode {
        const { isGuestEnabled } = this.props;

        const {
            customerViewType = isGuestEnabled ? CustomerViewType.Guest : CustomerViewType.Login,
        } = this.state;

        return (
            <CheckoutStep
                { ...step }
                heading={ <TranslatedString id="customer.customer_heading" /> }
                key={ step.type }
                onEdit={ this.handleEditStep }
                onExpanded={ this.handleExpanded }
                summary={
                    <CustomerInfo
                        onSignOut={ this.handleSignOut }
                        onSignOutError={ this.handleError }
                    />
                }
            >
                <LazyContainer>
                    <Customer
                        checkEmbeddedSupport={ this.checkEmbeddedSupport }
                        isEmbedded={ isEmbedded() }
                        onAccountCreated={ this.navigateToNextIncompleteStep }
                        onChangeViewType={ this.setCustomerViewType }
                        onContinueAsGuest={ this.navigateToNextIncompleteStep }
                        onContinueAsGuestError={ this.handleError }
                        onReady={ this.handleReady }
                        onSignIn={ this.navigateToNextIncompleteStep }
                        onSignInError={ this.handleError }
                        onUnhandledError={ this.handleUnhandledError }
                        viewType={ customerViewType }
                    />
                </LazyContainer>
            </CheckoutStep>
        );
    }

    private renderShippingStep(step: CheckoutStepStatus): ReactNode {
        const {
            hasCartChanged,
            cart,
            consignments = [],
        } = this.props;

        const {
            isBillingSameAsShipping,
            isMultiShippingMode,
        } = this.state;

        if (!cart) {
            return;
        }

        return (
            <CheckoutStep
                { ...step }
                heading={ <TranslatedString id="shipping.shipping_heading" /> }
                key={ step.type }
                onEdit={ this.handleEditStep }
                onExpanded={ this.handleExpanded }
                summary={ consignments.map(consignment =>
                    <div className="staticConsignmentContainer" key={ consignment.id }>
                        <StaticConsignment
                            cart={ cart }
                            compactView={ consignments.length < 2 }
                            consignment={ consignment }
                        />
                    </div>) }
            >
                <LazyContainer>
                    <Shipping
                        cartHasChanged={ hasCartChanged }
                        isBillingSameAsShipping={ isBillingSameAsShipping }
                        isMultiShippingMode={ isMultiShippingMode }
                        navigateNextStep={ this.handleShippingNextStep }
                        onCreateAccount={ this.handleShippingCreateAccount }
                        onReady={ this.handleReady }
                        onSignIn={ this.handleShippingSignIn }
                        onToggleMultiShipping={ this.handleToggleMultiShipping }
                        onUnhandledError={ this.handleUnhandledError }
                    />
                </LazyContainer>
            </CheckoutStep>
        );
    }

    private renderBillingStep(step: CheckoutStepStatus): ReactNode {
        const { billingAddress } = this.props;

        return (
            <CheckoutStep
                { ...step }
                heading={ <TranslatedString id="billing.billing_heading" /> }
                key={ step.type }
                onEdit={ this.handleEditStep }
                onExpanded={ this.handleExpanded }
                summary={ billingAddress && <StaticBillingAddress address={ billingAddress } /> }
            >
                <LazyContainer>
                    <Billing
                        navigateNextStep={ this.navigateToNextIncompleteStep }
                        onReady={ this.handleReady }
                        onUnhandledError={ this.handleUnhandledError }
                    />
                </LazyContainer>
            </CheckoutStep>
        );
    }

    private renderHeader(): ReactNode {
        // const {
        //     error,
        //     title = error && isCustomError(error) && error.title,
        // } = this.props;

        return (
            <ModalHeader>
                { /* <IconError additionalClassName="icon--error modal-header-icon" size={ IconSize.Small } /> */ }
                { /* { title || <TranslatedString id="common.error_heading" /> } */ }
                { 'Restricted Brands' }
            </ModalHeader>
        );
    }

    private renderPaymentStep(step: CheckoutStepStatus): ReactNode {
        const {
            consignments,
            cart,
        } = this.props;
        const showPayment = false;
        const {quoteType} = this.state;
        console.log(quoteType);
        // const onChangeQuoteType(event: React.FormEvent<HTMLSelectElement>) => {

        // }



        return (
            <CheckoutStep
                { ...step }
                heading={ <TranslatedString id="payment.payment_heading" /> }
                key={ step.type }
                onEdit={ this.handleEditStep }
                onExpanded={ this.handleExpanded }
            >
                <LazyContainer>
                    { showPayment ?
                    <Payment
                        checkEmbeddedSupport={ this.checkEmbeddedSupport }
                        isEmbedded={ isEmbedded() }
                        isUsingMultiShipping={ cart && consignments ? isUsingMultiShipping(consignments, cart.lineItems) : false }
                        onCartChangedError={ this.handleCartChangedError }
                        onFinalize={ this.navigateToOrderConfirmation }
                        onReady={ this.handleReady }
                        onSubmit={ this.navigateToOrderConfirmation }
                        onSubmitError={ this.handleError }
                        onUnhandledError={ this.handleUnhandledError }
                    />

                    :
                    <Fieldset
                        additionalClassName="creditCardFieldset"
                    >
                        <div className="" style={ {padding: 20 + 'px'} }>
                            <div style={ {marginBottom: 20 + 'px'} }>
                                <Label>
                                    Type of quote
                                </Label>
                                <div style={ {display:' flex', alignItems: 'center'} }>
                                    <input 
                                        checked={ quoteType === 'screen' } 
                                        // className="form-radio optimizedCheckout-form-radio" 
                                        name="Screen Printing" 
                                        onChange = { ()=> {this.setState({quoteType: 'screen'})} }
                                        style={ {marginRight: '10px'} } 
                                        type="radio"
                                        value="screen"
                                    />
                                    <label 
                                        className=""
                                        onClick = { ()=> {this.setState({quoteType: 'screen'})} }
                                    >
                                        Screen Printing
                                    </label>
                                </div>
                                <div style={ {display:' flex', alignItems: 'center'} }>
                                    <input 
                                        checked={ quoteType === 'embroidery' } 
                                        // className="form-radio optimizedCheckout-form-radio" 
                                        name="embroidery" 
                                        onChange = { ()=> {this.setState({quoteType: 'embroidery'})} }
                                        style={ {marginRight: '10px'} } 
                                        type="radio" 
                                        value="embroidery"
                                    />
                                    <label
                                        className=""
                                        onClick = { ()=> {this.setState({quoteType: 'embroidery'})} }
                                    >
                                    Embroidery
                                    </label>
                                </div>
                                <div style={ {display:' flex', alignItems: 'center'} }>
                                    <input 
                                        checked={ quoteType === 'unsure' } 
                                        // className="form-radio optimizedCheckout-form-radio" 
                                        name="unsure" 
                                        onChange = { ()=> {this.setState({quoteType: 'unsure'})} }
                                        style={ {marginRight: '10px'} } 
                                        type="radio" 
                                        value="unsure"
                                    />
                                    <label
                                        className=""
                                        onClick = { ()=> {this.setState({quoteType: 'unsure'})} }
                                    >
                                    Unsure
                                    </label>
                                </div>
                            </div>
                            <div style={ {marginBottom: 20 + 'px'} }>
                                <Label>
                                    Artwork file
                                </Label>
                                <input
                                    onChange={ this.onChangeFile }
                                    type="file"
                                />
                            </div>
                            <div style={ {marginBottom: 20 + 'px'} }>
                                <Label>
                                    Message
                                </Label>
                                <TextInput
                                    // { ...props.field }
                                    // autoComplete={ props.field.name }
                                    // id={ props.field.name }
                                    onChange = { (e) => {this.setState({message: e.target.value})} }
                                    type="text"
                                />
                            </div>
                            <div style={ {marginBottom: 20 + 'px'} }>
                            <Button
                                // disabled={ isLoading }
                                id="checkout-save-address"
                                // variant={ ButtonVariant.Primary }
                                // eslint-disable-next-line react/jsx-no-bind
                                // onClick = { () => this.setState({openRestrictedModal: !openRestrictedModal}) }
                                onClick = { ()=> this.onSubmitForm() }
                                style={ {
                                    float: 'right',
                                } }
                            >
                                Submit
                            </Button>
                            </div>

                        </div>

                    </Fieldset> }
                </LazyContainer>
            </CheckoutStep>
        );
    }

    private renderCartSummary(): ReactNode {
        return (
            <MobileView>
                { matched => {
                    if (matched) {
                        return <LazyContainer>
                            <CartSummaryDrawer />
                        </LazyContainer>;
                    }

                    return <aside className="layout-cart">
                        <LazyContainer>
                            <CartSummary />
                        </LazyContainer>
                    </aside>;
                } }
            </MobileView>
        );
    }

    private navigateToStep(type: CheckoutStepType, options?: { isDefault?: boolean }): void {
        const { clearError, error, steps } = this.props;
        const { activeStepType } = this.state;
        const step = find(steps, { type });

        if (!step) {
            return;
        }

        if (activeStepType === step.type) {
            return;
        }

        if (options && options.isDefault) {
            this.setState({ defaultStepType: step.type });
        } else {
            this.setState({ activeStepType: step.type });
        }

        if (error) {
            clearError(error);
        }
    }

    private handleToggleMultiShipping: () => void = () => {
        const { isMultiShippingMode } = this.state;

        this.setState({ isMultiShippingMode: !isMultiShippingMode });
    };

    private navigateToNextIncompleteStep: (options?: { isDefault?: boolean }) => void = options => {
        const { steps } = this.props;
        const activeStepIndex = findIndex(steps, { isActive: true });
        const activeStep = activeStepIndex >= 0 && steps[activeStepIndex];

        if (!activeStep) {
            return;
        }

        const previousStep = steps[Math.max(activeStepIndex - 1, 0)];

        if (previousStep && this.stepTracker) {
            this.stepTracker.trackStepCompleted(previousStep.type);
        }

        this.navigateToStep(activeStep.type, options);
    };

    private navigateToOrderConfirmation: () => void = () => {
        const { steps } = this.props;

        if (this.stepTracker) {
            this.stepTracker.trackStepCompleted(steps[steps.length - 1].type);
        }

        if (this.embeddedMessenger) {
            this.embeddedMessenger.postComplete();
        }

        this.setState({ isRedirecting: true }, () => {
            navigateToOrderConfirmation();
        });
    };

    private checkEmbeddedSupport: (methodIds: string[]) => boolean = methodIds => {
        const { embeddedSupport } = this.props;

        return embeddedSupport.isSupported(...methodIds);
    };

    private handleCartChangedError: (error: CartChangedError) => void = () => {
        this.navigateToStep(CheckoutStepType.Shipping);
    };

    private handleConsignmentsUpdated: (state: CheckoutSelectors) => void = ({ data }) => {
        const {
            hasSelectedShippingOptions: prevHasSelectedShippingOptions,
            activeStepType,
        } = this.state;

        const { steps } = this.props;

        const newHasSelectedShippingOptions = hasSelectedShippingOptions(data.getConsignments() || []);

        if (prevHasSelectedShippingOptions &&
            !newHasSelectedShippingOptions &&
            findIndex(steps, { type: CheckoutStepType.Shipping }) < findIndex(steps, { type: activeStepType })
        ) {
            this.navigateToStep(CheckoutStepType.Shipping);
            this.setState({ error: new ShippingOptionExpiredError() });
        }

        this.setState({ hasSelectedShippingOptions: newHasSelectedShippingOptions });
    };

    private handleCloseErrorModal: () => void = () => {
        this.setState({ error: undefined });
    };

    private handleExpanded: (type: CheckoutStepType) => void = type => {
        if (this.stepTracker) {
           this.stepTracker.trackStepViewed(type);
        }
    };

    private handleUnhandledError: (error: Error) => void = error => {
        this.handleError(error);

        // For errors that are not caught and handled by child components, we
        // handle them here by displaying a generic error modal to the shopper.
        this.setState({ error });
    };

    private handleError: (error: Error) => void = error => {
        const { errorLogger } = this.props;

        errorLogger.log(error);

        if (this.embeddedMessenger) {
            this.embeddedMessenger.postError(error);
        }
    };

    private handleEditStep: (type: CheckoutStepType) => void = type => {
        this.navigateToStep(type);
    };

    private handleReady: () => void = () => {
        this.navigateToNextIncompleteStep({ isDefault: true });
    };

    private handleSignOut: (event: CustomerSignOutEvent) => void = ({ isCartEmpty }) => {
        const { loginUrl, isGuestEnabled } = this.props;

        if (this.embeddedMessenger) {
            this.embeddedMessenger.postSignedOut();
        }

        if (isGuestEnabled) {
            this.setCustomerViewType(CustomerViewType.Guest);
        }

        if (isCartEmpty) {
            this.setState({ isCartEmpty: true });

            if (!isEmbedded()) {
                return window.top.location.assign(loginUrl);
            }
        }

        this.navigateToStep(CheckoutStepType.Customer);
    };

    private handleShippingNextStep: (isBillingSameAsShipping: boolean) => void = isBillingSameAsShipping => {
        this.setState({ isBillingSameAsShipping });

        if (isBillingSameAsShipping) {
            this.navigateToNextIncompleteStep();
        } else {
            this.navigateToStep(CheckoutStepType.Billing);
        }
    };

    private handleShippingSignIn: () => void = () => {
        this.setCustomerViewType(CustomerViewType.Login);
    };

    private handleShippingCreateAccount: () => void = () => {
        this.setCustomerViewType(CustomerViewType.CreateAccount);
    };

    private setCustomerViewType: (viewType: CustomerViewType) => void = customerViewType => {
        const {
            canCreateAccountInCheckout,
            createAccountUrl,
        } = this.props;

        if (customerViewType === CustomerViewType.CreateAccount &&
            (!canCreateAccountInCheckout || isEmbedded())
        ) {
            window.top.location.replace(createAccountUrl);

            return;
        }

        this.navigateToStep(CheckoutStepType.Customer);
        this.setState({ customerViewType });
    };
}

export default withLanguage(withCheckout(mapToCheckoutProps)(Checkout));
